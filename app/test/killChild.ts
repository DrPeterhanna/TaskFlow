// Child process for the real-kill test: queues two writes in a file-backed DB, starts a push whose server never answers, then waits to be killed.
import { Outbox, PersonalTaskRepo, SyncEngine, migrate } from '../src/sync/index.js';
import { openNodeSqlite } from '../src/sync/nodeSqlite.js';
const db = openNodeSqlite(process.argv[3]!); migrate(db);
const outbox = new Outbox(db);
const repo = new PersonalTaskRepo(db, outbox);
repo.create('Survives kill one'); repo.create('Survives kill two');
const hang = { call: () => new Promise(() => { console.log('SENDING'); }), pull: () => new Promise(() => {}) };
void new SyncEngine(db, outbox, hang as never).push();
setInterval(() => {}, 1000);
