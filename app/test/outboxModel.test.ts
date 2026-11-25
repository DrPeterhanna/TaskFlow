import {expect,it} from 'vitest';
import {Outbox,migrate} from '../src/sync/index';
import {openNodeSqlite} from '../src/sync/nodeSqlite';

it('seeded outbox restart/retry model never changes transmitted IDs or payloads or loses intents',()=>{
 const db=openNodeSqlite();migrate(db);let box=new Outbox(db,{now:()=>1_800_000_000_000}); let seed=74123;
 const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};
 const model=new Map<number,{id:string;args:string;sent:boolean}>();
 for(let step=0;step<1000;step++){
  const action=rand()%6;
  if(action<2||!model.size){ const op=box.enqueue({rpc:'create_personal_task',entityType:'personal_tasks',entityId:`e${step}`,args:[`e${step}`,null,`intent${step}`,null]});model.set(op.seq,{id:op.op_id,args:op.args_json,sent:false}); }
  else {
   const next=box.next();
   if(next){const m=model.get(next.seq)!;
    if(action===2){box.markInflight(next.seq);m.sent=true;box.retryLater(next.seq,0);}
    else if(action===3){box.markInflight(next.seq);m.sent=true;box.ack(next.seq);}
    else if(action===4){box.markInflight(next.seq);m.sent=true;box=new Outbox(db,{now:()=>1_800_000_000_000});box.recoverInflight();}
    else {box.reject(next.seq,'stale_conflict');expect(box.retryRejected(next.seq)).toBe(false);}
   }
  }
  const rows=db.all<{seq:number;op_id:string;args_json:string;transmitted_json:string|null}>('select * from outbox');
  expect(rows.length).toBe(model.size);
  for(const row of rows){const m=model.get(row.seq)!;expect(row.op_id).toBe(m.id);expect(row.args_json).toBe(m.args);if(m.sent)expect(row.transmitted_json).toBe(m.args);}
 }
 expect(model.size).toBeGreaterThan(100);db.close?.();
});
