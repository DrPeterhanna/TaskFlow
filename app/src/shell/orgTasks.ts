import type { RpcClient, RpcResult } from '../sync/types';
import { uuidv7 } from '../sync/ids';
import type { Listing, ReadCall } from './shellModel';

export type OrgTaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type OrgTaskStatus = 'todo' | 'in_progress' | 'done' | 'canceled';

export interface OrgTaskRow {
  id: string;
  unit_id: string;
  unit_name: string;
  assignee_membership_id: string | null;
  assignee_name: string | null;
  created_by_membership_id: string;
  creator_name: string;
  title: string;
  notes: string | null;
  priority: OrgTaskPriority;
  status: OrgTaskStatus;
  due_date: string | null;
  created_at: string;
  is_mine: boolean;
}

export function createOrgTasksApi(read: ReadCall, rpc: RpcClient) {
  async function list(): Promise<Listing<OrgTaskRow>> {
    let r;
    try { r = await read('list_org_tasks', {}); } catch { return { ok: false, error: 'network' }; }
    if (r.error) return { ok: false, error: r.status === 401 ? 'unauthorized' : r.status === 0 ? 'network' : 'unknown' };
    const d = r.data as { ok?: boolean; data?: OrgTaskRow[] } | null;
    return d?.ok && Array.isArray(d.data) ? { ok: true, rows: d.data } : { ok: false, error: 'unknown' };
  }

  return {
    list,
    create: (
      title: string,
      unitId: string,
      assigneeMembershipId: string | null = null,
      priority: OrgTaskPriority = 'normal',
      dueDate: string | null = null,
      notes: string | null = null,
      opId = uuidv7(),
    ): Promise<RpcResult> => rpc.call('create_org_task', [title, unitId, assigneeMembershipId, priority, dueDate, notes], opId),
    setStatus: (taskId: string, status: OrgTaskStatus, opId = uuidv7()): Promise<RpcResult> =>
      rpc.call('set_org_task_status', [taskId, status], opId),
    remove: (taskId: string, opId = uuidv7()): Promise<RpcResult> =>
      rpc.call('delete_org_task', [taskId], opId),
  };
}

export type OrgTasksApi = ReturnType<typeof createOrgTasksApi>;
