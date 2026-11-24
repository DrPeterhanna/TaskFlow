export interface TaskItem { id: string; title: string; done: boolean; pending: boolean }
export interface StoreState {
  tasks: TaskItem[];
  online: boolean;
  waiting: number;
  needAttention: number;
}
/** What the UI sees. The real implementation reads only from local SQLite. */
export interface TaskStore {
  getState(): StoreState;
  subscribe(fn: () => void): () => void;
  add(title: string): void;
  toggle(id: string): void;
  remove(id: string): void;
  setOnline?(online: boolean): void;   // preview only
}
