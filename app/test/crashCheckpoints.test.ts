import {it,expect} from 'vitest';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openNodeSqlite} from '../src/sync/nodeSqlite';
import {Outbox,migrate} from '../src/sync/index';

it('real SIGKILL at explicit outbox/resync checkpoints preserves transaction boundaries',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tf-checkpoint-'));
 try{
 for(const point of ['before_enqueue','after_enqueue','after_commit','after_inflight','after_ack','resync_during_fetch','resync_after_delete']){
  const file=join(dir,point+'.db');let stderr='';const child=spawn(process.execPath,['--experimental-sqlite','test/killRunner.mjs','test/crashCheckpointChild.ts',file,point],{cwd:process.cwd(),stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>stderr+=String(b));
  const result=await new Promise<{code:number|null;signal:string|null}>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('checkpoint timed out: '+point+' '+stderr));},15000);child.on('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
  expect(result.signal,point+' '+stderr).toBe('SIGKILL');const db=openNodeSqlite(file);migrate(db);const box=new Outbox(db);
  if(point==='before_enqueue'||point==='after_enqueue'){expect(db.all('select * from local_rows'),point).toHaveLength(0);expect(db.all('select * from outbox'),point).toHaveLength(0);}
  else if(point==='resync_during_fetch'||point==='resync_after_delete'){expect(db.all('select * from local_rows'),point).toHaveLength(2);expect(box.counts().queued,point).toBe(1);expect(db.all<{id:string}>("select id from local_rows where id='cached'")).toHaveLength(1);}
  else{const rows=db.all<{op_id:string;state:string;args_json:string}>('select * from outbox');expect(rows,point).toHaveLength(1);const id=rows[0]!.op_id;expect(rows[0]!.state,point).toBe(point==='after_inflight'?'inflight':point==='after_ack'?'acked':'queued');box.recoverInflight();expect(box.byOpId(id)?.op_id).toBe(id);expect(db.all('select * from local_rows')).toHaveLength(1);}
  db.close?.();
 }
 }finally{rmSync(dir,{recursive:true,force:true});}
},120000);
