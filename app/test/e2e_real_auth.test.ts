import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseRpcClient } from '../src/supabase/rpcClient';
import { Outbox, PersonalTaskRepo, SyncEngine, migrate, TransportError, type RpcClient } from '../src/sync';
import { openNodeSqlite } from '../src/sync/nodeSqlite';

const enabled = process.env.TASKFLOW_REAL_AUTH_E2E === '1';
const key = 'taskflow-local-development-only';
const url = 'http://127.0.0.1:54321';
let backend: ChildProcess;
let output = '';
beforeAll(async () => {
  if (!enabled) return;
  backend = spawn(process.env.TASKFLOW_TEST_PYTHON ?? 'python3', [resolve('../dev/real-auth/launch.py')], {
    env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'tf-native-path-e2e-')) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout!.on('data', d => { output += d.toString(); });
  backend.stderr!.on('data', d => { output += d.toString(); });
  for (let i = 0; i < 300; i++) {
    if (backend.exitCode !== null) throw new Error('Backend stopped: ' + output);
    try { if ((await fetch(url + '/health')).ok) return; } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Backend readiness timeout: ' + output);
}, 60_000);
afterAll(async () => {
  if (!backend || backend.exitCode !== null) return;
  const done = new Promise<void>(r => backend.once('exit', () => r()));
  backend.kill('SIGTERM'); await done;
});
async function account() {
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.auth.signUp({ email: `e2e-${crypto.randomUUID()}@local.test`, password: crypto.randomUUID() + crypto.randomUUID() });
  if (error || !data.session) throw new Error(error?.message ?? 'No genuine Auth session');
  return { sb, rpc: createSupabaseRpcClient(sb), token: data.session.access_token };
}
function device(rpc: RpcClient) {
  const db = openNodeSqlite(); migrate(db);
  const outbox = new Outbox(db);
  return { db, outbox, repo: new PersonalTaskRepo(db, outbox), engine: new SyncEngine(db, outbox, rpc, undefined, () => 0) };
}
describe.skipIf(!enabled)('genuine local Auth + gateway + PostgREST + production TS sync adapter, node SQLite, NOT Android/hosted', () => {
  it('two offline devices converge through real HTTP and current Auth tokens', async () => {
    const {rpc} = await account(); const a = device(rpc), b = device(rpc);
    const id = a.repo.create('Real HTTP offline create');
    expect(a.repo.get(id)?.pending).toBe(true);
    expect((await a.engine.push()).acked).toBe(1);
    expect(await b.engine.pull('personal_tasks')).toBe(1);
    expect(b.repo.get(id)).toMatchObject({ title: 'Real HTTP offline create', pending: false });
  });
  it('actual HTTP response lost after commit retries same op and creates one task', async () => {
    const {rpc} = await account(); let drop = true;
    const flaky: RpcClient = { ...rpc, call: async (...args) => { const result = await rpc.call(...args); if (drop) { drop = false; throw new TransportError('Test: response lost after real commit'); } return result; } };
    const a=device(flaky), b=device(rpc); const id=a.repo.create('One task only');
    expect((await a.engine.push()).status).toBe('waiting');
    a.db.run('update outbox set next_attempt_at=0');
    expect((await a.engine.push()).acked).toBe(1);
    await b.engine.pull('personal_tasks'); expect(b.repo.list().map(t=>t.id)).toEqual([id]);
  });
  it('remote edit wins over stale offline delete without silent overwrite', async () => {
    const {rpc}=await account(); const a=device(rpc), b=device(rpc);
    const id=a.repo.create('Base'); await a.engine.push(); await b.engine.pull('personal_tasks');
    b.repo.update(id,{title:'Other device edit'}); await b.engine.push(); a.repo.remove(id);
    expect((await a.engine.push()).rejected).toBe(1);
    expect(a.outbox.rejected()[0]?.error_code).toBe('stale_conflict');
    const c=device(rpc); await c.engine.pull('personal_tasks'); expect(c.repo.get(id)?.title).toBe('Other device edit');
  });
  it('a second real account cannot pull another account tasks', async () => {
    const owner=await account(), stranger=await account(); const a=device(owner.rpc), b=device(stranger.rpc);
    a.repo.create('Private'); await a.engine.push(); expect(await b.engine.pull('personal_tasks')).toBe(0);
  });
  it('real logout blocks saved old JWT at production RPC adapter', async () => {
    const {sb,token}=await account(); const stale=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},accessToken:async()=>token});
    expect((await sb.auth.signOut({scope:'local'})).error).toBeNull();
    const result=await createSupabaseRpcClient(stale).call('create_personal_task',[crypto.randomUUID(),null,'Denied ghost',null], '019ac1e0-0000-7000-8000-'+crypto.randomUUID().replaceAll('-','').slice(0,12));
    expect(result).toMatchObject({ok:false,code:'unauthenticated'});
  });
});


it.skipIf(!enabled)('genuine stored session opens local identity after expiry offline, without granting a network session', async () => {
  const {createOfflineIdentity,registerOfflineIdentity} = await import('../src/auth/offlineIdentity');
  const {createSupabaseAuthApi,createAuthController} = await import('../src/auth/authController');
  const values=new Map<string,string>(); const storage={getItem:async(k:string)=>values.get(k)??null,setItem:async(k:string,v:string)=>{values.set(k,v);},removeItem:async(k:string)=>{values.delete(k);}};
  const online=createClient(url,key,{auth:{storageKey:'offline-test',storage,autoRefreshToken:false,persistSession:true}});
  const signed=await online.auth.signUp({email:`offline-${crypto.randomUUID()}@local.test`,password:crypto.randomUUID()+crypto.randomUUID()});
  expect(signed.error).toBeNull();expect(signed.data.session).toBeTruthy();
  await online.auth.signOut({scope:'others'}); // Keep this device session and fixture in isolated storage.
  online.auth.stopAutoRefresh();
  // Force reactive refresh using the genuine stored credential, without editing tokens or real clocks.
  const raw=JSON.parse(values.get('offline-test')!);raw.expires_at=1;values.set('offline-test',JSON.stringify(raw));
  let disconnected=true;
  const offline=createClient(url,key,{global:{fetch:async(...args:Parameters<typeof fetch>)=>{if(disconnected) throw new Error('Network request failed');return fetch(...args);}},auth:{storageKey:'offline-test',storage,autoRefreshToken:false,persistSession:true}});
  registerOfflineIdentity(offline,createOfflineIdentity(storage,'offline-test'));
  const api=createSupabaseAuthApi(offline);const controller=createAuthController(api);await controller.start();
  expect(controller.getState().session).toMatchObject({userId:signed.data.user!.id,localOnly:true});
  expect((await offline.auth.getSession()).data.session).toBeNull();
  const d=device({call:async()=>{throw new TransportError('offline');},pull:async()=>{throw new TransportError('offline');}});
  d.repo.create('Queued with expired access session');expect(d.db.all("select * from outbox where state='queued'")).toHaveLength(1);
  disconnected=false;
  let refreshError:unknown=true;
  for(let i=0;i<65;i++){ refreshError=(await offline.auth.refreshSession()).error;if(!refreshError)break;await new Promise(r=>setTimeout(r,1000)); }
  expect(refreshError).toBeNull();
  await new Promise(r=>setTimeout(r,0));expect(controller.getState().session?.localOnly).toBeUndefined();
  // New valid session is available to account-bound network clients, not the expired cached token.
  expect((await offline.auth.getSession()).data.session?.user.id).toBe(signed.data.user!.id);
  disconnected=true;
  await expect(controller.signOut()).rejects.toBeTruthy();expect(controller.getState().phase).toBe('signedOut');
  expect(values.has('offline-test')).toBe(false); // Actual installed SDK removed credentials despite failed HTTP logout.
  expect(await api.getSession()).toBeNull();expect(d.db.all("select * from outbox where state='queued'")).toHaveLength(1);
  controller.dispose();d.db.close?.();offline.auth.stopAutoRefresh();
},110000);

it.skipIf(!enabled)('UI store persists offline create and checked rename to disk, then reconnects once through genuine Auth HTTP',async()=>{
 const {createSqliteStore}=await import('../src/store/sqliteStore');const {rpc}=await account();
 const file=join(mkdtempSync(join(tmpdir(),'tf-store-http-disk-')),'tasks.db');let down=true;
 const network:RpcClient={call:(...a)=>{if(down)throw new TransportError('disconnected','network');return rpc.call(...a);},pull:(...a)=>{if(down)throw new TransportError('disconnected','network');return rpc.pull(...a);},status:(...a)=>{if(down)throw new TransportError('disconnected','network');return rpc.status!(...a);}};
 let db=openNodeSqlite(file);let store=createSqliteStore(db,network,{autoSync:false});store.add('Created without backend');const id=store.getState().tasks[0]!.id;store.rename!(id,'Edited without backend','Created without backend');await store.sync();expect(store.getState().waiting).toBe(2);store.dispose?.();db.close?.();
 db=openNodeSqlite(file);store=createSqliteStore(db,network,{autoSync:false});expect(store.getState().tasks[0]).toMatchObject({id,title:'Edited without backend',pending:true});expect(store.getState().waiting).toBe(2);
 down=false;await store.connectivityRestored();expect(store.getState().waiting).toBe(0);expect(store.getState().tasks[0]).toMatchObject({title:'Edited without backend',pending:false});await store.connectivityRestored();
 const other=device(rpc);await other.engine.pull('personal_tasks');expect(other.repo.list()).toHaveLength(1);expect(other.repo.get(id)?.title).toBe('Edited without backend');store.dispose?.();db.close?.();other.db.close?.();
},15000);


it.skipIf(!enabled)('real SDK logout attempts credential cleanup even when persistent local lock write fails',async()=>{
 const {createOfflineIdentity,registerOfflineIdentity}=await import('../src/auth/offlineIdentity');const {createSupabaseAuthApi}=await import('../src/auth/authController');
 const values=new Map<string,string>();const storage={getItem:async(k:string)=>values.get(k)??null,setItem:async(k:string,v:string)=>{if(k.endsWith('.local-locked'))throw Error('storage failure');values.set(k,v);},removeItem:async(k:string)=>{values.delete(k);}};
 let down=false;const client=createClient(url,key,{global:{fetch:async(...args:Parameters<typeof fetch>)=>{if(down)throw Error('network unavailable');return fetch(...args);}},auth:{storageKey:'lock-failure',storage,persistSession:true,autoRefreshToken:false}});
 const r=await client.auth.signUp({email:`lockfail-${crypto.randomUUID()}@local.test`,password:crypto.randomUUID()+crypto.randomUUID()});expect(r.error).toBeNull();const identity=createOfflineIdentity(storage,'lock-failure');registerOfflineIdentity(client,identity);down=true;
 await expect(createSupabaseAuthApi(client).signOut()).rejects.toThrow('local_logout_failed');expect(await identity.locked()).toBe(true);expect(values.has('lock-failure')).toBe(false);expect((await client.auth.getSession()).data.session).toBeNull();client.auth.stopAutoRefresh();
},10000);

it.skipIf(!enabled)('genuine HTTP refuses queued stale same-field title edit and retains explicit rejected intent',async()=>{
 const {rpc}=await account();const a=device(rpc),b=device(rpc);const id=a.repo.create('Shared base title');await a.engine.push();await b.engine.pull('personal_tasks');
 a.repo.update(id,{title:'Offline older intent'});b.repo.update(id,{title:'Newer committed intent'});await b.engine.push();
 expect((await a.engine.push()).rejected).toBe(1);expect(a.outbox.rejected()[0]?.error_code).toBe('stale_conflict');expect(JSON.parse(a.outbox.rejected()[0]!.args_json)[1]).toEqual({title:'Offline older intent'});
 const reader=device(rpc);await reader.engine.pull('personal_tasks');expect(reader.repo.get(id)?.title).toBe('Newer committed intent');a.db.close?.();b.db.close?.();reader.db.close?.();
});
it.skipIf(!enabled)('genuine HTTP lost checked-title-edit reply replays identical op and ends with no duplicate task',async()=>{
 const {rpc}=await account();let drop=false;const flaky:RpcClient={...rpc,call:async(...args)=>{const result=await rpc.call(...args);if(drop){drop=false;throw new TransportError('test lost edit reply after real commit','network');}return result;}};
 const a=device(flaky);const id=a.repo.create('Before lost edit reply');await a.engine.push();await a.engine.pull('personal_tasks');a.repo.update(id,{title:'After lost edit reply'});const op=a.db.all<{op_id:string}>("select op_id from outbox where state='queued'")[0]!.op_id;drop=true;
 expect((await a.engine.push()).status).toBe('waiting');expect(a.db.all<{op_id:string}>("select op_id from outbox where state='queued'")[0]!.op_id).toBe(op);a.db.run('update outbox set next_attempt_at=0');expect((await a.engine.push()).acked).toBe(1);
 const reader=device(rpc);await reader.engine.pull('personal_tasks');expect(reader.repo.list()).toHaveLength(1);expect(reader.repo.get(id)?.title).toBe('After lost edit reply');expect(a.outbox.rejected()).toHaveLength(0);a.db.close?.();reader.db.close?.();
});

it.skipIf(!enabled)('bounded genuine HTTP offline/restart churn keeps all checked task versions without duplicate IDs',async()=>{
 const {createSqliteStore}=await import('../src/store/sqliteStore');const {rpc}=await account();const file=join(mkdtempSync(join(tmpdir(),'tf-real-churn-')),'tasks.db');
 const expected=new Map<string,{title:string;done:boolean}>();let down=true;
 const network:RpcClient={call:(...a)=>{if(down)throw new TransportError('offline','network');return rpc.call(...a);},pull:(...a)=>{if(down)throw new TransportError('offline','network');return rpc.pull(...a);},status:(...a)=>{if(down)throw new TransportError('offline','network');return rpc.status!(...a);}};
 for(let batch=0;batch<5;batch++){
  let db=openNodeSqlite(file);let store=createSqliteStore(db,network,{autoSync:false});down=true;
  for(let i=0;i<10;i++){const title=`Batch${batch} Task${i}`;store.add(title);const task=store.getState().tasks.find(t=>t.title===title)!;store.rename!(task.id,title+' edited',title);store.toggle(task.id);expected.set(task.id,{title:title+' edited',done:true});}
  await store.sync();expect(store.getState().waiting).toBe(30);store.dispose?.();db.close?.();
  db=openNodeSqlite(file);store=createSqliteStore(db,network,{autoSync:false});expect(store.getState().tasks).toHaveLength((batch+1)*10);down=false;await store.connectivityRestored();expect(store.getState().waiting).toBe(0);expect(store.getState().needAttention).toBe(0);await store.connectivityRestored();store.dispose?.();db.close?.();
 }

 const read=device(rpc);await read.engine.pull('personal_tasks');expect(read.repo.list()).toHaveLength(50);for(const task of read.repo.list()){expect({title:task.title,done:task.status==='done'}).toEqual(expected.get(task.id));}read.db.close?.();
},30000);

it.skipIf(!enabled)('50 tasks/150 operations survive actual Node process exits, repeated lost replies and seven-row pull pagination',async()=>{
 const {token}=await account();const dir=mkdtempSync(join(tmpdir(),'tf-process-churn-'));const file=join(dir,'writer.db');
 const worker=(input:Record<string,unknown>)=>new Promise<any>((resolveOutput,reject)=>{const p=spawn(process.execPath,[resolve('test/processChurnWorker.cjs')],{stdio:['pipe','pipe','pipe']});let text='',errors='';p.stdout.on('data',d=>text+=d);p.stderr.on('data',d=>errors+=d);p.on('exit',code=>{if(code)reject(new Error(errors));else{try{resolveOutput(JSON.parse(text));}catch(e){reject(e);}}});p.stdin.end(JSON.stringify({...input,token}));});
 const created=await worker({mode:'create',file});expect(created.intent).toHaveLength(150);expect(new Set(created.intent.map((x:any)=>x.op_id)).size).toBe(150);expect(created.states).toEqual([{state:'queued',n:150}]);
 const attempts:any[]=[];
 // Every invocation is a fresh OS process, reopening the same on-disk queue.
 for(const dropAt of [1,37,53]){const partial=await worker({mode:'push',file,dropAt});attempts.push(...partial.attempts);expect(partial.report.status).toBe('waiting');}
 const final=await worker({mode:'push',file});attempts.push(...final.attempts);expect(final.states).toEqual([{state:'acked',n:150}]);expect(final.report.rejected).toBe(0);
 const byId=new Map<string,any[]>();for(const a of attempts)byId.set(a.op_id,[...(byId.get(a.op_id)??[]),a]);expect(byId.size).toBe(150);expect(attempts.length).toBe(153);
 for(const intent of created.intent){const seen=byId.get(intent.op_id)!;expect(seen.length).toBeGreaterThan(0);for(const a of seen){expect(a.rpc).toBe(intent.rpc);expect(a.args).toBe(intent.args_json);expect(a.result).toEqual(seen[0].result);expect(a.result.ok).toBe(true);}}
 const reader=join(dir,'reader.db');const interrupted=await worker({mode:'pull',file:reader,dropPullAt:3});expect(interrupted.error).toContain('pull reply interruption');expect(interrupted.tasks).toHaveLength(14);expect(interrupted.cursor).toHaveLength(1);
 const resumed=await worker({mode:'pull',file:reader});expect(resumed.error).toBeUndefined();expect(resumed.tasks).toHaveLength(50);expect(new Set(resumed.tasks.map((t:any)=>t.id)).size).toBe(50);expect(resumed.pages).toBeGreaterThan(1);
 const fresh=await worker({mode:'pull',file:join(dir,'fresh-reader.db')});expect(fresh.tasks).toHaveLength(50);expect(fresh.pages).toBe(8);
 const expected=new Map(created.tasks.map((t:any)=>[t.id,{title:t.title,status:t.status}]));for(const result of [resumed,fresh])for(const r of result.rows){expect({title:r.title,status:r.status}).toEqual(expected.get(r.id));expect(r.row_version).toBe(3);}
 const again=await worker({mode:'push',file});expect(again.attempts).toHaveLength(0);expect(again.states).toEqual([{state:'acked',n:150}]);
},60000);
