// Separate Node process for durable disk/replay acceptance. Not Expo SQLite or Android.
const fs=require('node:fs');const ts=require('typescript');
require.extensions['.ts']=(mod,name)=>mod._compile(ts.transpileModule(fs.readFileSync(name,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,name);
const {createClient}=require('@supabase/supabase-js');
const {createSupabaseRpcClient}=require('../src/supabase/rpcClient.ts');
const {openNodeSqlite}=require('../src/sync/nodeSqlite.ts');
const {migrate,Outbox,PersonalTaskRepo,SyncEngine,TransportError}=require('../src/sync/index.ts');
(async()=>{
 const input=JSON.parse(fs.readFileSync(0,'utf8'));const db=openNodeSqlite(input.file);migrate(db);const box=new Outbox(db);const repo=new PersonalTaskRepo(db,box);
 const output={};
 if(input.mode==='create'){
  for(let i=0;i<50;i++){const id=repo.create('Process task '+i);repo.update(id,{title:'Process task '+i+' edited'});repo.complete(id);}
  output.intent=db.all('select op_id,rpc,args_json from outbox order by seq');output.tasks=repo.list();
 }else{
  const sb=createClient('http://127.0.0.1:54321','taskflow-local-development-only',{auth:{persistSession:false,autoRefreshToken:false},accessToken:async()=>input.token});const rpc=createSupabaseRpcClient(sb);const attempts=[];let calls=0,pulls=0;
  const transport={...rpc,call:async(...a)=>{const r=await rpc.call(...a);attempts.push({op_id:a[2],rpc:a[0],args:JSON.stringify(a[1]),result:r});if(++calls===input.dropAt)throw new TransportError('Injected reply loss AFTER genuine server commit','network');return r;},pull:async(...a)=>{const page=await rpc.pull(...a);if(++pulls===input.dropPullAt)throw new TransportError('Injected pull reply interruption','network');return page;}};
  const engine=new SyncEngine(db,box,transport,undefined,()=>0);
  if(input.mode==='push'){db.run('update outbox set next_attempt_at=0');output.report=await engine.push();output.attempts=attempts;}
  else{try{output.applied=await engine.pull('personal_tasks',7);}catch(e){output.error=e.message;}output.cursor=db.all('select * from sync_cursor');output.tasks=repo.list();output.rows=db.all('select data_json from local_rows').map(x=>JSON.parse(x.data_json));output.pages=pulls;}
 }
 output.states=db.all('select state,count(*) as n from outbox group by state');db.close();process.stdout.write(JSON.stringify(output));
})().catch(e=>{console.error(e);process.exitCode=1;});
