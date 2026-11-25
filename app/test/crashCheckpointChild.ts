import {Outbox,PersonalTaskRepo,SyncEngine,migrate} from '../src/sync/index';
import {openNodeSqlite} from '../src/sync/nodeSqlite';
import type {SqlDriver} from '../src/sync/types';
const path=process.argv[3]!,point=process.argv[4]!;
const raw=openNodeSqlite(path);migrate(raw);
const kill=()=>{process.kill(process.pid,'SIGKILL');};
if(point==='before_enqueue'||point==='after_enqueue'){
 raw.transaction(()=>{raw.run("insert into local_rows(stream,id,data_json,pending) values('personal_tasks','new','{}',1)");if(point==='before_enqueue')kill();new Outbox(raw).enqueue({rpc:'create_personal_task',entityType:'personal_tasks',entityId:'new',args:['new']});kill();});
}else if(point==='after_commit'||point==='after_inflight'||point==='after_ack'){
 const box=new Outbox(raw);new PersonalTaskRepo(raw,box).create('Durable');if(point==='after_commit')kill();const op=box.next()!;box.markInflight(op.seq);if(point==='after_inflight')kill();box.ack(op.seq);kill();
}else{
 raw.run("insert into local_rows(stream,id,data_json,change_xid,pending) values('personal_tasks','cached',?,'2',0)",[JSON.stringify({id:'cached',title:'Cached',status:'todo'})]);
 const box=new Outbox(raw);new PersonalTaskRepo(raw,box).create('Pending intent');
 const db:SqlDriver={...raw,run(sql,args){const result=raw.run(sql,args);if(point==='resync_after_delete'&&sql.startsWith('delete from local_rows'))kill();return result;}};
 const rpc={call:async()=>({ok:true as const,data:{}}),pull:async()=>{if(point==='resync_during_fetch')kill();return {rows:[],horizon:'10',next_xid:null,next_id:null};}};
 await new SyncEngine(db,box,rpc).fullResync('personal_tasks');kill();
}
