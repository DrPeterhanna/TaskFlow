import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { TransportError, type PullPage, type RpcClient, type RpcResult } from '../src/sync/index.js';

/** TEST ONLY: talks to tests/bridge.py (local PostgreSQL, not Supabase). */
export class Bridge {
  proc!: ChildProcess;
  base = '';
  async start(): Promise<void> {
    this.proc = spawn('python3', ['../tests/bridge.py'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const rl = createInterface({ input: this.proc.stdout! });
    this.base = await new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error('bridge start timeout')), 60_000);
      rl.on('line', (l) => { const m = /^READY (\d+)/.exec(l); if (m) { clearTimeout(t); res(`http://127.0.0.1:${m[1]}`); } });
      this.proc.on('exit', () => rej(new Error('bridge exited')));
    });
  }
  stop(): void { this.proc?.kill('SIGTERM'); }
  async post(path: string, body: unknown): Promise<any> {
    const r = await fetch(this.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new TransportError(`${r.status} ${JSON.stringify(j)}`, r.status === 401 ? 'unauthorized' : 'server');
    return j;
  }
  user(email: string): Promise<string> { return this.post('/user', { email }).then((j) => j.id as string); }
  sql(query: string): Promise<unknown[][]> { return this.post('/sql', { query }).then((j) => j.rows as unknown[][]); }
  dropNextResponses(n: number): Promise<unknown> { return this.post('/fault', { drop: n }); }
  client(uid: string): RpcClient {
    return {
      call: async (rpc, args, opId) => (await this.post('/rpc', { uid, fn: rpc, args, op: opId })) as RpcResult,
      pull: async (stream, afterXid, afterId, horizon, limit) =>
        (await this.post('/pull', { uid, stream, after_xid: afterXid, after_id: afterId, horizon, limit })) as PullPage,
    };
  }
}
