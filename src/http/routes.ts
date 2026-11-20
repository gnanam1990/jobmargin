import type { DatabaseSync } from 'node:sqlite';
import { Router, sendHtml, type Ctx } from './server.ts';
import * as jobs from '../domain/jobs.ts';
import * as consoleUi from './console.ts';

export function buildRouter(db: DatabaseSync): Router {
  const r = new Router();

  r.get('/health', () => ({ ok: true, service: 'jobmargin' }), { auth: false });

  // ---- FR-01: jobs & quotes --------------------------------------------
  r.post('/jobs', (c: Ctx) => jobs.createJob(c.db, c.actor, c.body));
  r.get('/jobs', (c: Ctx) => ({ jobs: jobs.listJobs(c.db, c.actor) }));
  r.post('/jobs/{id}/quotes', (c: Ctx) => jobs.createQuote(c.db, c.actor, c.params.id, c.body));
  r.post('/jobs/{id}/quotes/{version}/lock', (c: Ctx) =>
    jobs.lockQuote(c.db, c.actor, c.params.id, Number(c.params.version)));
  r.get('/jobs/{id}', (c: Ctx) => jobs.jobDetail(c.db, c.actor, c.params.id));

  // ---- console (server-rendered operator UI) ---------------------------
  r.get('/', (c) => sendHtml(c.res, 200, consoleUi.layout(consoleUi.home(c))), { auth: false });
  r.get('/login', (c) => sendHtml(c.res, 200, consoleUi.layout(consoleUi.loginPage())), { auth: false });
  r.post('/login', (c) => consoleUi.doLogin(c), { auth: false });
  r.get('/ui/jobs', (c) => sendHtml(c.res, 200, consoleUi.layout(consoleUi.jobList(c), c.actor)));
  r.get('/ui/jobs/{id}', (c) =>
    sendHtml(c.res, 200, consoleUi.layout(consoleUi.jobPage(c), c.actor)));

  return r;
}
