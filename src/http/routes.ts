import type { DatabaseSync } from 'node:sqlite';
import { Router, sendHtml, type Ctx } from './server.ts';
import * as jobs from '../domain/jobs.ts';
import * as ledger from '../domain/ledger.ts';
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

  // ---- FR-02: cost attribution -------------------------------------------
  r.post('/jobs/{id}/costs', (c: Ctx) => ledger.postCost(c.db, c.actor, c.params.id, c.body));
  r.post('/jobs/{id}/costs/{seq}/reverse', (c: Ctx) =>
    ledger.reverseEntry(c.db, c.actor, c.params.id, Number(c.params.seq), c.body));
  r.get('/jobs/{id}/ledger', (c: Ctx) =>
    ({ entries: ledger.ledgerEntries(c.db, c.params.id), net_costs_minor: ledger.netCosts(c.db, c.params.id) }));
  r.post('/statements/import', (c: Ctx) => ledger.importStatement(c.db, c.actor, c.body));
  r.get('/statements/{id}', (c: Ctx) => ledger.statementDetail(c.db, c.actor, c.params.id));
  r.post('/jobs/{id}/flags', (c: Ctx) => ledger.raiseFlag(c.db, c.actor, c.params.id, c.body));
  r.post('/jobs/{id}/flags/{flag}/resolve', (c: Ctx) =>
    ledger.resolveFlag(c.db, c.actor, c.params.id, c.params.flag, c.body));

  // ---- console (server-rendered operator UI) ---------------------------
  r.get('/', (c) => sendHtml(c.res, 200, consoleUi.layout(consoleUi.home(c))), { auth: false });
  r.get('/login', (c) => sendHtml(c.res, 200, consoleUi.layout(consoleUi.loginPage())), { auth: false });
  r.post('/login', (c) => consoleUi.doLogin(c), { auth: false });
  r.get('/ui/jobs', (c) => sendHtml(c.res, 200, consoleUi.layout(consoleUi.jobList(c), c.actor)));
  r.get('/ui/jobs/{id}', (c) =>
    sendHtml(c.res, 200, consoleUi.layout(consoleUi.jobPage(c), c.actor)));

  return r;
}
