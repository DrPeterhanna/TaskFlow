import type { TaskStore } from './TaskStore';

/** Only dismiss an editor after the durable local mutation succeeds. */
export function saveTaskTitle(store: Pick<TaskStore, 'rename'>, id: string, draft: string, expectedTitle?: string): { ok: true } | { ok: false; reason: 'invalid' | 'storage' | 'unsupported' } {
  const title = draft.trim();
  if (!title || title.length > 300) return { ok: false, reason: 'invalid' };
  if (!store.rename) return { ok: false, reason: 'unsupported' };
  try { store.rename(id, title, expectedTitle); return { ok: true }; }
  catch { return { ok: false, reason: 'storage' }; }
}
