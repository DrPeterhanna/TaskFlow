import type { StoreState, TaskItem, TaskStore } from './TaskStore';

/** PREVIEW ONLY: in-memory store that imitates pending/synced to show the UI. It is not the sync engine. */
export function createMemoryStore(seed: TaskItem[] = []): TaskStore {
  let tasks = seed;
  let online = true;
  const subs = new Set<() => void>();
  let state: StoreState = compute();
  function compute(): StoreState {
    return { tasks, online, waiting: tasks.filter((t) => t.pending).length, needAttention: 0 };
  }
  const emit = () => { state = compute(); subs.forEach((f) => f()); };
  const flush = () => { if (online) { tasks = tasks.map((t) => ({ ...t, pending: false })); emit(); } };
  let n = 100;
  return {
    getState: () => state,
    subscribe: (f) => { subs.add(f); return () => { subs.delete(f); }; },
    add(title) { tasks = [{ id: `m${n++}`, title: title.trim(), done: false, pending: true }, ...tasks]; emit(); setTimeout(flush, 600); },
    toggle(id) { tasks = tasks.map((t) => (t.id === id ? { ...t, done: !t.done, pending: true } : t)); emit(); setTimeout(flush, 600); },
    remove(id) { tasks = tasks.filter((t) => t.id !== id); emit(); },
    setOnline(o) { online = o; emit(); flush(); },
  };
}
