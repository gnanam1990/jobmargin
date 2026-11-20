import type { DatabaseSync } from 'node:sqlite';
import { Router, sendHtml, type Ctx } from './server.ts';
import * as jobs from '../domain/jobs.ts';
import * as ledger from '../domain/ledger.ts';
import * as reservations from '../domain/reservations.ts';
import * as dispatch from '../domain/dispatch.ts';
import * as receipts from '../domain/receipts.ts';
import * as reports from '../domain/reports.ts';
import { listProviders } from '../providers/registry.ts';
import { unauthorized } from '../domain/errors.ts';
import type { Actor } from '../domain/authz.ts';
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

  // ---- FR-03: reservations & margin view ---------------------------------
  r.post('/jobs/{id}/reservations', (c: Ctx) => {
    const key = c.req.headers['idempotency-key'];
    const body = { ...c.body, request_key: c.body.request_key ?? (typeof key === 'string' ? key : undefined) };
    return reservations.createReservation(c.db, c.actor, c.params.id, body);
  });
  r.get('/jobs/{id}/reservations', (c: Ctx) =>
    ({ reservations: reservations.listReservations(c.db, c.actor, c.params.id) }));
  r.get('/jobs/{id}/margin', (c: Ctx) => reports.marginView(c.db, c.actor, c.params.id));

  // ---- FR-04: dispatch & providers ----------------------------------------
  r.post('/reservations/{id}/dispatch', (c: Ctx) =>
    dispatch.dispatchReservation(c.db, c.actor, c.params.id, c.body));
  r.get('/jobs/{id}/attempts', (c: Ctx) =>
    ({ attempts: dispatch.listAttempts(c.db, c.actor, c.params.id) }));
  r.get('/providers', (c: Ctx) => ({ providers: listProviders(c.db) }));

  // ---- FR-05: receipts, exceptions, reconciliation -----------------------
  r.post('/receipts/import', (c: Ctx) => receipts.importReceipt(c.db, c.actor, c.body, 'import'));
  // Provider webhook: shared-secret verified (emulator rail); unverified
  // callbacks are rejected as evidence of settlement (SECURITY.md).
  r.post('/receipts/webhook', (c: Ctx) => {
    const secret = process.env.JM_WEBHOOK_SECRET ?? 'dev-secret';
    if (c.req.headers['x-webhook-secret'] !== secret) throw unauthorized('invalid webhook signature');
    const actor: Actor = {
      id: 'webhook', tenant_id: String(c.body.tenant_id ?? ''), role: 'finance',
      client_id: null, display_name: 'provider webhook',
    };
    return receipts.importReceipt(c.db, actor, c.body, 'webhook');
  }, { auth: false });
  r.get('/receipts', (c: Ctx) => ({ receipts: receipts.listReceipts(c.db, c.actor) }));
  r.get('/jobs/{id}/receipts', (c: Ctx) =>
    ({ receipts: receipts.listReceipts(c.db, c.actor, c.params.id) }));
  r.get('/exceptions', (c: Ctx) => ({ exceptions: receipts.listExceptions(c.db, c.actor) }));
  r.post('/exceptions/{id}/resolve', (c: Ctx) =>
    receipts.resolveException(c.db, c.actor, c.params.id, c.body));

  // ---- console (server-rendered operator UI) ---------------------------
  r.get('/', (c) => sendHtml(c.res, 200, consoleUi.layout(consoleUi.home(c))), { auth: false });
  r.get('/login', (c) => sendHtml(c.res, 200, consoleUi.layout(consoleUi.loginPage())), { auth: false });
  r.post('/login', (c) => consoleUi.doLogin(c), { auth: false });
  r.get('/ui/jobs', (c) => sendHtml(c.res, 200, consoleUi.layout(consoleUi.jobList(c), c.actor)));
  r.get('/ui/jobs/{id}', (c) =>
    sendHtml(c.res, 200, consoleUi.layout(consoleUi.jobPage(c), c.actor)));

  return r;
}
