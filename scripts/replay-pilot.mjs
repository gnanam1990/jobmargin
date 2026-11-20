// Replays the labelled pilot sample (fixtures/pilot/pilot-record.json) through
// the normal HTTP and UI entry points on a fresh local database, then writes
// build-progress/jobmargin/PILOT-RESULT.md with actual vs expected outcomes.
//
//   node scripts/replay-pilot.mjs
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const { openDb, migrate, nowIso } = await import(join(REPO, 'src/db/connection.ts'));
const { ensureProviders } = await import(join(REPO, 'src/providers/registry.ts'));
const { token, uuid } = await import(join(REPO, 'src/domain/ids.ts'));
const { buildRouter } = await import(join(REPO, 'src/http/routes.ts'));
const { createApp } = await import(join(REPO, 'src/http/server.ts'));
const consoleUi = await import(join(REPO, 'src/http/console.ts'));
const { createWorker } = await import(join(REPO, 'src/worker/worker.ts'));
const { makeEmulator, memStore } = await import(join(REPO, 'src/providers/emulator.ts'));

const dbDir = join(REPO, '.test-tmp', 'pilot-run');
rmSync(dbDir, { recursive: true, force: true });
mkdirSync(dbDir, { recursive: true });
const db = openDb(join(dbDir, 'pilot.db'));
migrate(db);
ensureProviders(db);

// labelled demo tenant + role actors (sample data, not real people)
db.prepare('INSERT INTO tenants (id, name, kind, created_at) VALUES (?,?,?,?)')
  .run('pilot-tenant', 'Pilot Replay Tenant (synthetic)', 'demo', nowIso());
const actors = {};
for (const [key, role, name, clientId] of [
  ['lead', 'lead', 'Replay Lead', null],
  ['worker', 'worker', 'Replay Worker', null],
  ['finance', 'finance', 'Replay Finance', null],
  ['clientAcme', 'client', 'Replay Client', 'client-acme'],
]) {
  const t = token();
  db.prepare(`INSERT INTO actors (id, tenant_id, role, client_id, display_name, token, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(uuid(), 'pilot-tenant', role, clientId, name, t, nowIso());
  actors[key] = { token: t, role };
}

const server = createApp({
  db, router: buildRouter(db),
  renderError: (err, actor) => consoleUi.layout(consoleUi.errorPage(err, actor), actor),
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const api = async (actor, method, path, body, headers = {}) => {
  const h = { ...headers };
  if (actor) h.authorization = `Bearer ${actor.token}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null), text: await res.text().catch(() => '') };
};

const record = JSON.parse(readFileSync(join(REPO, 'fixtures/pilot/pilot-record.json'), 'utf8'));
const worker = createWorker(db, { emulator: makeEmulator({ store: memStore() }) });
const ctx = {};
const lines = [`# Pilot replay result — ${record.id}`, '',
  `Record: \`${record.label}\``, '',
  '| Step | Expected | Actual |', '|---|---|---|'];
let failures = 0;
const log = (step, expected, actual, ok) => {
  if (!ok) failures++;
  lines.push(`| ${step} | ${expected} | ${actual} |`);
};

for (const step of record.steps) {
  const actor = step.actor ? actors[step.actor] : null;
  switch (step.op) {
    case 'create_job': {
      const r = await api(actor, 'POST', '/jobs', step.input);
      ctx.jobId = r.json.job_id;
      log('create job', '200', String(r.status), r.status === 200);
      break;
    }
    case 'quote': {
      const r = await api(actor, 'POST', `/jobs/${ctx.jobId}/quotes`, step.input);
      log('quote 1000/300', 'draft v1', `v${r.json.version}`, r.status === 200);
      break;
    }
    case 'lock_quote': {
      const r = await api(actor, 'POST', `/jobs/${ctx.jobId}/quotes/${step.version}/lock`);
      log('lock quote', 'locked', r.json.status, r.json.status === 'locked');
      break;
    }
    case 'post_cost': {
      const r = await api(actor, 'POST', `/jobs/${ctx.jobId}/costs`, step.input);
      log('post 680c labor', 'posted', `seq=${r.json.entry_seq}`, r.status === 200);
      break;
    }
    case 'reserve': {
      const r = await api(actor, 'POST', `/jobs/${ctx.jobId}/reservations`, step.input,
        { 'idempotency-key': step.key });
      const rv = r.json.reservation;
      if (rv.state === 'held') ctx.reservationId = rv.id;
      log(`reserve ${step.key} (${step.input.amount_minor}c)`,
        step.expect.denial_code ? `denied ${step.expect.denial_code}` : step.expect.state,
        rv.state === 'denied' ? `denied ${rv.denial_code} shortfall=${rv.shortfall_minor}` : rv.state,
        rv.state === step.expect.state && (!step.expect.denial_code || rv.denial_code === step.expect.denial_code));
      break;
    }
    case 'dispatch': {
      const r = await api(actor, 'POST', `/reservations/${ctx.reservationId}/dispatch`, step.input);
      log('dispatch 15c', 'queued', r.status === 200 ? `queued ${r.json.action_id.slice(0, 8)}` : `HTTP ${r.status}`, r.status === 200);
      break;
    }
    case 'worker_tick': {
      const out = await worker.tick();
      log('worker tick', 'processes outbox', `claimed=${out.claimed}`, out.claimed >= 1);
      break;
    }
    case 'receipt': {
      const att = db.prepare('SELECT provider_ref FROM attempts WHERE reservation_id = ?').get(ctx.reservationId);
      const r = await api(actor, 'POST', '/receipts/import', { ...step.input, provider_ref: att.provider_ref });
      log('import receipt 12c', 'settled release=3', `${r.json.status} release=${r.json.released_minor}`,
        r.json.status === 'settled' && r.json.released_minor === 3);
      break;
    }
    case 'deliver': {
      const r = await api(actor, 'POST', `/jobs/${ctx.jobId}/deliveries`, step.input);
      ctx.deliveryId = r.json.delivery_id;
      log('deliver artifact', 'v1', `v${r.json.version}`, r.status === 200);
      break;
    }
    case 'accept': {
      const r = await api(actor, 'POST', `/deliveries/${ctx.deliveryId}/accept`);
      log('client accept', 'accepted', String(r.status), r.status === 200);
      break;
    }
    case 'close': {
      const r = await api(actor, 'POST', `/jobs/${ctx.jobId}/close`);
      log('close v1', `margin=${step.expect.realized_margin_minor} ${step.expect.completeness}`,
        `margin=${r.json.realized_margin_minor} ${r.json.completeness}`,
        r.json.realized_margin_minor === step.expect.realized_margin_minor);
      break;
    }
    case 'ui_check': {
      const page = await fetch(`${base}/ui/jobs/${ctx.jobId}`, { headers: { cookie: `jm_session=${actors.lead.token}` } });
      const html = await page.text();
      const ok = step.contains.every((s) => new RegExp(s).test(html));
      log('console shows margin', step.contains.join(' + '), ok ? 'rendered' : 'MISSING', ok);
      break;
    }
  }
}
lines.push('', `**Result: ${failures === 0 ? 'ALL EXPECTED OUTCOMES OBSERVED' : failures + ' unexpected outcome(s)'}**`);
server.close();
db.close();
writeFileSync(join(REPO, 'build-progress/jobmargin/PILOT-RESULT.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
