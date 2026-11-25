import {it,expect} from 'vitest';
import {validatePullPage,validateSyncStatus} from '../src/sync/validation';
import {SyncEngine,Outbox,migrate} from '../src/sync/index';
import {openNodeSqlite} from '../src/sync/nodeSqlite';
import type {RpcClient,PullPage} from '../src/sync/types';
const good={rows:[{id:'a',change_xid:'2',title:'Good'}],horizon:'10',next_xid:'2',next_id:'a'};
it('rejects malformed pages before applying rows or advancing a cursor',async()=>{
 const invalid:unknown[]=[null,{}, {...good,rows:null},{...good,horizon:'NaN'},{...good,horizon:'18446744073709551616'},{...good,next_xid:'9'}, {...good,next_id:null},{...good,rows:[{id:'a',change_xid:'10'}]}, {...good,rows:[{id:'a',change_xid:'-1'}]}, {...good,rows:[{id:'b',change_xid:'2'},{id:'a',change_xid:'2'}]}, {...good,rows:[{id:'a',change_xid:'2'},{id:'a',change_xid:'2'}]}, {...good,rows:[]}, {...good,rows:[{id:'a',change_xid:'2',deleted_at:true}]}];
 for(const value of invalid){const db=openNodeSqlite();migrate(db);const rpc:RpcClient={call:async()=>({ok:true,data:{}}),pull:async()=>value as PullPage};const engine=new SyncEngine(db,new Outbox(db),rpc);
 await expect(engine.pull('personal_tasks')).rejects.toMatchObject({kind:'server'});expect(db.all('select * from local_rows')).toHaveLength(0);expect(db.all('select * from sync_cursor')).toHaveLength(0);db.close?.();}
});
it('validates short pages too, bounds, monotonic progress and pinned horizons',()=>{
 expect(()=>validatePullPage(good,'0','',null,200)).not.toThrow();
 expect(()=>validatePullPage(good,'2','a',null,200)).toThrow();
 expect(()=>validatePullPage(good,'0','','9',200)).toThrow();
 expect(()=>validatePullPage(good,'0','',null,0)).toThrow();
 expect(()=>validatePullPage({...good,rows:[],next_xid:null,next_id:null},'2','a','10',200)).not.toThrow();
});
it('invalid second page cannot poison a previously committed valid page cursor',async()=>{
 const db=openNodeSqlite();migrate(db);let n=0;const rpc:RpcClient={call:async()=>({ok:true,data:{}}),pull:async()=>n++?{...good,rows:[{id:'b',change_xid:'3'}],next_xid:'3',next_id:'b',horizon:'11'}:good};
 await expect(new SyncEngine(db,new Outbox(db),rpc).pull('personal_tasks',1)).rejects.toMatchObject({kind:'server'});
 expect(db.all<{id:string}>('select id from local_rows')).toEqual([{id:'a'}]);expect(db.all<{after_xid:string}>('select after_xid from sync_cursor')[0]!.after_xid).toBe('2');db.close?.();
});
it('status requires explicit boolean, bounded numeric floor and integer safety capability',()=>{
 for(const value of [null,{}, {full_resync_required:'false',floor_xid:'0'},{full_resync_required:false,floor_xid:'-1'},{full_resync_required:false,floor_xid:'0',mutation_safety_version:'2'},{full_resync_required:false,floor_xid:'0',mutation_safety_version:-1}])expect(()=>validateSyncStatus(value)).toThrow();
 expect(()=>validateSyncStatus({full_resync_required:false,floor_xid:'0',mutation_safety_version:2})).not.toThrow();
});

it('malformed mutation responses never acknowledge or reject unsent intent',async()=>{
 const invalid:unknown[]=[null,{},[],{ok:'true',data:{}},{ok:1,data:{}},{ok:true},{ok:false},{ok:false,code:42},{ok:false,code:'stale_conflict',message:{}}];
 for(const value of invalid){const db=openNodeSqlite();migrate(db);const box=new Outbox(db);const op=box.enqueue({rpc:'create_personal_task',entityType:'personal_tasks',entityId:'task',args:['task',null,'Keep intent',null]});
 const rpc:RpcClient={call:async()=>value as never,pull:async()=>({rows:[],horizon:'1',next_xid:null,next_id:null})};
 const report=await new SyncEngine(db,box,rpc).push();expect(report.acked).toBe(0);expect(report.rejected).toBe(0);expect(box.byOpId(op.op_id)).toMatchObject({state:'queued',args_json:op.args_json});db.close?.();}
});
