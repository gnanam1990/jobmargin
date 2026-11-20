import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileFixture, httpFixture, type HttpFixture, type Fixture } from './helpers.ts';
import { openDb, migrate } from '../src/db/connection.ts';
import { createWorker } from '../src/worker/worker.ts';
import { makeEmulator, memStore } from '../src/providers/emulator.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Restart: close server + db, reopen on the same file, serve again. */
async function restart(fx: HttpFixture): Promise<HttpFixture> {
  fx.server.close();
  fx.db.close();
  const db2 = openDb(fx.dbPath);
  migrate(db2);
  const fx2 = { ...fx, db: db2 } as Fixture;
  return httpFixture(fx2);
}

async function phaseThroughReservation(fx: HttpFixture) {
  let res = await fx.api(fx.actors.lead, 'POST', '/jobs',
    { client_id: 'client-acme', title: 'ACME report', currency: 'USD' });
  const jobId = res.json.job_id as string;
  await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/quotes`, { price_minor: 1000, min_margin_minor: 300 });
  await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/quotes/1/lock`);
  await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/costs`, { kind: 'labor', amount_minor: 680 });
  res = await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/reservations`,
    { amount_minor: 15, quote_version: 1 }, { 'idempotency-key': 'call-1' });
  return { jobId, reservationId: res.json.reservation.id as string };
}

// T-015: restart after reservation and before statement import; recovered
// job yields the same 308-cent final result.
test('T-015: process restart preserves decisions; recovered job closes at 308', async () => {
  let fx = await httpFixture();
  try {
    const { jobId, reservationId } = await phaseThroughReservation(fx);
    const store = memStore();
    await fx.api(fx.actors.worker, 'POST', `/reservations/${reservationId}/dispatch`,
      { provider_key: 'emulator', session_cap_minor: 15 });
    await createWorker(fx.db, { emulator: makeEmulator({ store }) }).tick();

    // --- process restart: everything below happens on a fresh DB handle ---
    fx = await restart(fx);

    // budget decision survived the restart
    let m = await fx.api(fx.actors.lead, 'GET', `/jobs/${jobId}/margin`);
    assert.equal(m.json.open_holds_minor, 15);

    const attempt = fx.db.prepare('SELECT provider_ref FROM attempts WHERE reservation_id = ?')
      .get(reservationId) as { provider_ref: string };
    let res = await fx.api(fx.actors.finance, 'POST', '/receipts/import', {
      provider_key: 'emulator', provider_ref: attempt.provider_ref,
      merchant: 'emulator-merchant', asset: 'USDTEST', amount_minor: 12,
    });
    assert.equal(res.json.status, 'settled');
    res = await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/deliveries`,
      { artifact_hash: 'sha256:report-final-001' });
    res = await fx.api(fx.actors.clientAcme, 'POST', `/deliveries/${res.json.delivery_id}/accept`);
    assert.equal(res.status, 200);
    res = await fx.api(fx.actors.finance, 'POST', `/jobs/${jobId}/close`);
    assert.equal(res.json.realized_margin_minor, 308);

    // INV-08: journal totals + acceptance identity intact across restart
    const led = await fx.api(fx.actors.finance, 'GET', `/jobs/${jobId}/ledger`);
    assert.equal(led.json.net_costs_minor, 692);
    const acc = fx.db.prepare(
      `SELECT a.display_name FROM acceptances ac JOIN actors a ON a.id = ac.actor_id`,
    ).get() as { display_name: string };
    assert.equal(acc.display_name, 'Clio Client');
    fx.server.close();
  } finally { fx.cleanup(); }
});

// Two simultaneous workers: one claim, one charge.
test('two workers racing one outbox row dispatch exactly once', async () => {
  const fx = await httpFixture();
  try {
    const { reservationId } = await phaseThroughReservation(fx);
    await fx.api(fx.actors.worker, 'POST', `/reservations/${reservationId}/dispatch`,
      { provider_key: 'emulator', session_cap_minor: 15 });
    const store = memStore();
    const w1 = createWorker(fx.db, { emulator: makeEmulator({ store }) }, { workerId: 'w1' });
    const w2 = createWorker(fx.db, { emulator: makeEmulator({ store }) }, { workerId: 'w2' });
    await Promise.all([w1.tick(), w2.tick()]);
    const attempt = fx.db.prepare('SELECT status FROM attempts WHERE reservation_id = ?')
      .get(reservationId) as { status: string };
    assert.equal(attempt.status, 'confirmed');
    assert.equal(store.all().size, 1, 'exactly one provider charge for two workers');
  } finally { fx.cleanup(); }
});

// Late receipt: a receipt arriving long after the dispatch settles once.
test('late receipt after restart settles the held amount once', async () => {
  let fx = await httpFixture();
  try {
    const { jobId, reservationId } = await phaseThroughReservation(fx);
    const store = memStore();
    await fx.api(fx.actors.worker, 'POST', `/reservations/${reservationId}/dispatch`,
      { provider_key: 'emulator', session_cap_minor: 15 });
    await createWorker(fx.db, { emulator: makeEmulator({ store }) }).tick();
    fx = await restart(fx);                       // days pass; process bounces
    const attempt = fx.db.prepare('SELECT provider_ref FROM attempts WHERE reservation_id = ?')
      .get(reservationId) as { provider_ref: string };
    let res = await fx.api(fx.actors.finance, 'POST', '/receipts/import', {
      provider_key: 'emulator', provider_ref: attempt.provider_ref,
      merchant: 'emulator-merchant', asset: 'USDTEST', amount_minor: 15,
    });
    assert.equal(res.json.status, 'settled');
    res = await fx.api(fx.actors.finance, 'POST', '/receipts/import', {
      provider_key: 'emulator', provider_ref: attempt.provider_ref,
      merchant: 'emulator-merchant', asset: 'USDTEST', amount_minor: 15,
    });
    assert.equal(res.json.replayed, true);
    const led = await fx.api(fx.actors.finance, 'GET', `/jobs/${jobId}/ledger`);
    assert.equal(led.json.entries.filter((e: any) => e.kind === 'provider_expense').length, 1);
    fx.server.close();
  } finally { fx.cleanup(); }
});

// T-016: absent external authorization or receipt lookup, keep the evidence
// conditional and show the unresolved hold.
test('T-016: provider without status lookup leaves the unresolved hold visible', async () => {
  const fx = await httpFixture();
  try {
    const { jobId, reservationId } = await phaseThroughReservation(fx);
    await fx.api(fx.actors.worker, 'POST', `/reservations/${reservationId}/dispatch`,
      { provider_key: 'emulator', session_cap_minor: 15 });
    // ambiguous execute + no status mechanism: nothing can be established
    const worker = createWorker(fx.db, { emulator: makeEmulator({ mode: 'lookup-down', store: memStore() }) });
    await worker.tick();
    const r = fx.db.prepare('SELECT state FROM reservations WHERE id = ?').get(reservationId) as any;
    assert.equal(r.state, 'uncertain');
    const attempt = fx.db.prepare('SELECT status, last_error FROM attempts WHERE reservation_id = ?')
      .get(reservationId) as any;
    assert.equal(attempt.status, 'uncertain');

    // the operator sees the unresolved hold — it is not quietly released
    const m = await fx.api(fx.actors.lead, 'GET', `/jobs/${jobId}/margin`);
    assert.equal(m.json.open_holds_minor, 15);
    const rec = await fx.api(fx.actors.finance, 'GET', `/jobs/${jobId}/reconciliation`);
    const uncertainAttempt = (rec.json.attempts as any[]).find((a) => a.status === 'uncertain');
    assert.ok(uncertainAttempt, 'uncertain attempt visible in reconciliation view');
    const page = await fetch(`${fx.base}/ui/jobs/${jobId}`,
      { headers: { cookie: `jm_session=${fx.actors.lead.token}` } });
    assert.match(await page.text(), /uncertain/);

    // and the close is blocked until reconciled (INV-06)
    const res2 = await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/deliveries`,
      { artifact_hash: 'sha256:pending' });
    await fx.api(fx.actors.clientAcme, 'POST', `/deliveries/${res2.json.delivery_id}/accept`);
    const close = await fx.api(fx.actors.finance, 'POST', `/jobs/${jobId}/close`);
    assert.equal(close.json.error.code, 'UNRESOLVED_PAYMENTS');
  } finally { fx.cleanup(); }
});

// Pilot replay: the labelled sample record runs through the real HTTP API.
test('pilot record replays through normal entry points to a 308 close', async () => {
  const fx = await httpFixture();
  try {
    const record = JSON.parse(
      readFileSync(join(REPO, 'fixtures/pilot/pilot-record.json'), 'utf8'),
    ) as { id: string; steps: Record<string, any>[] };
    const store = memStore();
    const worker = createWorker(fx.db, { emulator: makeEmulator({ store }) });
    const ctx: { jobId?: string; reservationId?: string; deliveryId?: string } = {};
    for (const step of record.steps) {
      const actor = step.actor ? fx.actors[step.actor as keyof typeof fx.actors] : null;
      switch (step.op) {
        case 'create_job': {
          const r = await fx.api(actor!, 'POST', '/jobs', step.input);
          assert.equal(r.status, 200, `${step.op} failed`);
          ctx.jobId = r.json.job_id;
          break;
        }
        case 'quote':
          await fx.api(actor!, 'POST', `/jobs/${ctx.jobId}/quotes`, step.input);
          break;
        case 'lock_quote':
          await fx.api(actor!, 'POST', `/jobs/${ctx.jobId}/quotes/${step.version}/lock`);
          break;
        case 'post_cost': {
          const r = await fx.api(actor!, 'POST', `/jobs/${ctx.jobId}/costs`, step.input);
          assert.equal(r.status, 200);
          break;
        }
        case 'reserve': {
          const r = await fx.api(actor!, 'POST', `/jobs/${ctx.jobId}/reservations`,
            step.input, { 'idempotency-key': step.key });
          const rv = r.json.reservation;
          assert.equal(rv.state, step.expect.state, `${step.key}: ${rv.state}`);
          if (step.expect.denial_code) assert.equal(rv.denial_code, step.expect.denial_code);
          if (rv.state === 'held') ctx.reservationId = rv.id;
          break;
        }
        case 'dispatch': {
          const r = await fx.api(actor!, 'POST', `/reservations/${ctx.reservationId}/dispatch`, step.input);
          assert.equal(r.status, 200);
          break;
        }
        case 'worker_tick':
          await worker.tick();
          break;
        case 'receipt': {
          const att = fx.db.prepare('SELECT provider_ref FROM attempts WHERE reservation_id = ?')
            .get(ctx.reservationId) as { provider_ref: string };
          const r = await fx.api(actor!, 'POST', '/receipts/import',
            { ...step.input, provider_ref: att.provider_ref });
          assert.equal(r.json.status, 'settled');
          break;
        }
        case 'deliver': {
          const r = await fx.api(actor!, 'POST', `/jobs/${ctx.jobId}/deliveries`, step.input);
          ctx.deliveryId = r.json.delivery_id;
          break;
        }
        case 'accept': {
          const r = await fx.api(actor!, 'POST', `/deliveries/${ctx.deliveryId}/accept`);
          assert.equal(r.status, 200);
          break;
        }
        case 'close': {
          const r = await fx.api(actor!, 'POST', `/jobs/${ctx.jobId}/close`);
          assert.equal(r.json.realized_margin_minor, step.expect.realized_margin_minor);
          assert.equal(r.json.completeness, step.expect.completeness);
          break;
        }
        case 'ui_check': {
          const page = await fetch(`${fx.base}/ui/jobs/${ctx.jobId}`,
            { headers: { cookie: `jm_session=${fx.actors.lead.token}` } });
          const html = await page.text();
          for (const s of step.contains) assert.match(html, new RegExp(s));
          break;
        }
        default:
          throw new Error(`unknown pilot op ${step.op}`);
      }
    }
  } finally { fx.cleanup(); }
});
