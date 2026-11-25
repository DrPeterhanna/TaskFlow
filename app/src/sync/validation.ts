import {TransportError,type PullPage,type RpcResult} from './types';
const xid=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)&&v.length<=20&&BigInt(v)<=18446744073709551615n;
export function validatePullPage(value:unknown,afterXid:string,afterId:string,horizon:string|null,limit:number):asserts value is PullPage {
 const bad=()=>{throw new TransportError('invalid sync page; cursor and cache retained','server');};
 if(!value||typeof value!=='object') return bad();
 const p=value as PullPage;
 if(!xid(afterXid)||!xid(p.horizon)||horizon!==null&&p.horizon!==horizon||!Array.isArray(p.rows)||p.rows.length>limit)return bad();
 let prevX=BigInt(afterXid),prevId=afterId;
 for(const row of p.rows){
  if(!row||typeof row!=='object'||typeof row.id!=='string'||!row.id||!xid(row.change_xid)||BigInt(row.change_xid)>=BigInt(p.horizon))return bad();
  const x=BigInt(row.change_xid);
  if(x<prevX||x===prevX&&row.id<=prevId)return bad();
  if(row.deleted_at!==undefined&&row.deleted_at!==null&&typeof row.deleted_at!=='string')return bad();
  prevX=x;prevId=row.id;
 }
 if(p.rows.length===0){if(p.next_xid!==null||p.next_id!==null)return bad();}
 else if(p.next_xid!==prevX.toString()||p.next_id!==prevId)return bad();
}
export function validateSyncStatus(v:unknown):asserts v is {full_resync_required:boolean;floor_xid:string;mutation_safety_version?:number}{
 if(!v||typeof v!=='object')throw new TransportError('invalid sync status','server');
 const s=v as {full_resync_required?:unknown;floor_xid?:unknown;mutation_safety_version?:unknown};
 if(typeof s.full_resync_required!=='boolean'||!xid(s.floor_xid)||s.mutation_safety_version!==undefined&&(!Number.isSafeInteger(s.mutation_safety_version)||(s.mutation_safety_version as number)<0))throw new TransportError('invalid sync status','server');
}

/** A malformed success must never acknowledge durable intent. Treat it as a retryable server failure. */
export function validateRpcResult(value: unknown): asserts value is RpcResult {
 if(!value || typeof value !== 'object' || Array.isArray(value)) throw new TransportError('invalid mutation result','server');
 const r=value as Record<string,unknown>;
 if(r.ok===true && Object.prototype.hasOwnProperty.call(r,'data')) return;
 if(r.ok===false && typeof r.code==='string' && /^[a-z][a-z0-9_]{0,79}$/.test(r.code) && (r.message===undefined || typeof r.message==='string')) return;
 throw new TransportError('invalid mutation result','server');
}
