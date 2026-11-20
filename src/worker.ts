import { openDb, migrate } from './db/connection.ts';
import { ensureProviders } from './providers/registry.ts';
import { makeEmulator, dbStore } from './providers/emulator.ts';
import { makeKiteProvider } from './providers/kite.ts';
import { createWorker } from './worker/worker.ts';

const db = openDb(process.env.JM_DB ?? 'data/jobmargin.db');
migrate(db);
ensureProviders(db);

const providers = {
  // emulator state is durable (emulator_charges) so crash recovery can look
  // up charges after our own process restarts
  emulator: makeEmulator({ mode: process.env.JM_EMULATOR_MODE as never, store: dbStore(db) }),
  kite: makeKiteProvider(db),
};
const worker = createWorker(db, providers, { intervalMs: Number(process.env.JM_WORKER_MS ?? 500) });
worker.start();
console.log(`jobmargin worker ${worker.workerId} running (db=${process.env.JM_DB ?? 'data/jobmargin.db'})`);
