import { openDb, migrate } from './db/connection.ts';
import { buildRouter } from './http/routes.ts';
import { createApp } from './http/server.ts';
import * as consoleUi from './http/console.ts';
import { ensureProviders } from './providers/registry.ts';
import { makeEmulator, dbStore } from './providers/emulator.ts';
import { makeKiteProvider } from './providers/kite.ts';
import { createWorker } from './worker/worker.ts';
import type { Actor } from './domain/authz.ts';
import type { JmError } from './domain/errors.ts';

const dbPath = process.env.JM_DB ?? 'data/jobmargin.db';
const port = Number(process.env.PORT ?? 8080);
const db = openDb(dbPath);
migrate(db);
ensureProviders(db);

const router = buildRouter(db);
const app = createApp({
  db, router,
  renderError: (err: JmError, actor: Actor | null) =>
    consoleUi.layout(consoleUi.errorPage(err, actor), actor),
});
app.listen(port, () => {
  console.log(`jobmargin api+console listening on :${port} (db=${dbPath})`);
});
if (process.env.JM_EMBED_WORKER === '1') {
  const worker = createWorker(db, {
    emulator: makeEmulator({ store: dbStore(db) }),
    kite: makeKiteProvider(db),
  });
  worker.start();
  console.log(`embedded worker ${worker.workerId} started`);
}
