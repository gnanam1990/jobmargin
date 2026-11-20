import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture, type HttpFixture } from './helpers.ts';
import { createWorker } from '../src/worker/worker.ts';
import { makeEmulator, memStore } from '../src/providers/emulator.ts';
import { AmbiguousError, type ProviderAdapter } from '../src/providers/types.ts';
import { nowIso } from '../src/db/connection.ts';
import { uuid } from '../src/domain/ids.ts';

async function heldJob(fx: HttpFixture) {
  let res = await fx.api(fx.actors.lead, 'POST', '/jobs',
    { client_id: 'client-acme', title: 'ACME report', currency: 'USD' });
  const jobId = res.json.job_id as string;
  await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/quotes`, { price_minor: 1000, min_margin_minor: 300 });
  await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/quotes/1/lock`);
  await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/costs`, { kind: 'labor', amount_minor: 680 });
  res = await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/reservations`,
    { amount_minor: 15, quote_version: 1 }, { 'idempotency-key': 'call-1' });
  assert.equal(res.json.reservation.state, 'held');
  return { jobId, reservationId: res.json.reservation.id as string };
}

// T-007: a 15-cent hold can dispatch one authorized request for that
// merchant and persist its reference.
test('T-007: 15c hold dispatches to authorized merchant and persists provider ref', async () => {
  const fx = await httpFixture();
  try {
    const { jobId, reservationId } = await heldJob(fx);
    const store = memStore();
    const worker = createWorker(fx.db, { emulator: makeEmulator({ store }) }, { workerId: 'w1' });

    let res = await fx.api(fx.actors.worker, 'POST', `/reservations/${reservationId}/dispatch`,
      { provider_key: 'emulator', session_ref: 'sess-pilot-1', session_cap_minor: 15 });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.ok(res.json.attempt_id && res.json.action_id);

    await worker.tick();
    const attempt = fx.db.prepare('SELECT * FROM attempts WHERE reservation_id = ?')
      .get(reservationId) as any;
    assert.equal(attempt.status, 'confirmed');
    assert.ok(attempt.provider_ref, 'opaque provider reference persisted');
    assert.equal(attempt.merchant, 'emulator-merchant');

    const r = fx.db.prepare('SELECT state FROM reservations WHERE id = ?').get(reservationId) as any;
    assert.equal(r.state, 'dispatched'); // still occupies hold until a receipt settles
    assert.equal(store.all().size, 1); // exactly one provider charge
  } finally { fx.cleanup(); }
});

// T-008: a worker crash after external acceptance leaves an uncertain hold
// and no second payment after restart.
test('T-008: crash after provider accepted → uncertain hold, no second charge after restart', async () => {
  const fx = await httpFixture();
  try {
    const { jobId, reservationId } = await heldJob(fx);
    await fx.api(fx.actors.worker, 'POST', `/reservations/${reservationId}/dispatch`,
      { provider_key: 'emulator', session_cap_minor: 15 });

    const store = memStore();
    const emu = makeEmulator({ store });
    // adapter that charges, then loses the response; status lookup also down
    const crashAdapter: ProviderAdapter = {
      ...emu,
      execute: async (req) => {
        await emu.execute(req); // charge lands in the emulator's store
        throw new AmbiguousError('worker crashed after external acceptance');
      },
      status: async () => ({ known: false }), // lookup unavailable during crash
    };
    const w1 = createWorker(fx.db, { emulator: crashAdapter }, { workerId: 'crashed' });
    await w1.tick();

    let r = fx.db.prepare('SELECT state FROM reservations WHERE id = ?').get(reservationId) as any;
    assert.equal(r.state, 'uncertain', 'ambiguous outcome keeps the hold occupied');
    let m = await fx.api(fx.actors.lead, 'GET', `/jobs/${jobId}/margin`);
    assert.equal(m.json.open_holds_minor, 15); // INV-04: capacity not released
    assert.equal(store.all().size, 1);

    // restart: a new worker resolves the same action by status lookup only
    const w2 = createWorker(fx.db, { emulator: emu }, { workerId: 'recovered' });
    await w2.tick();
    r = fx.db.prepare('SELECT state FROM reservations WHERE id = ?').get(reservationId) as any;
    assert.equal(r.state, 'dispatched');
    const attempt = fx.db.prepare('SELECT status, provider_ref FROM attempts WHERE reservation_id = ?')
      .get(reservationId) as any;
    assert.equal(attempt.status, 'confirmed');
    assert.ok(attempt.provider_ref);
    assert.equal(store.all().size, 1, 'no second payment after restart');
  } finally { fx.cleanup(); }
});

// Hard-crash variant: worker dies leaving the outbox row 'claimed'.
test('restarts reap claimed outbox rows via status lookup, never re-execute', async () => {
  const fx = await httpFixture();
  try {
    const { reservationId } = await heldJob(fx);
    await fx.api(fx.actors.worker, 'POST', `/reservations/${reservationId}/dispatch`,
      { provider_key: 'emulator', session_cap_minor: 15 });
    // simulate: worker claimed the row, provider accepted, then died before finalize
    const store = memStore();
    const emu = makeEmulator({ store });
    const attempt = fx.db.prepare('SELECT * FROM attempts WHERE reservation_id = ?').get(reservationId) as any;
    await emu.execute({ action_id: attempt.action_id, amount_minor: 15, merchant: 'emulator-merchant' });
    fx.db.prepare(`UPDATE dispatch_outbox SET status='claimed', claimed_by='dead-worker', claimed_at=?`).run(nowIso());
    fx.db.prepare(`UPDATE attempts SET status='sent'`).run();

    const w = createWorker(fx.db, { emulator: emu }, { workerId: 'new-worker' });
    await w.tick();
    const after = fx.db.prepare('SELECT status, provider_ref FROM attempts WHERE id = ?').get(attempt.id) as any;
    assert.equal(after.status, 'confirmed');
    assert.equal(store.all().size, 1, 'provider was charged exactly once');
  } finally { fx.cleanup(); }
});

// External gate: dispatch to a provider without recorded authorization fails closed.
test('kite provider dispatch is denied while live execution is ungated', async () => {
  const fx = await httpFixture();
  try {
    const { reservationId } = await heldJob(fx);
    const res = await fx.api(fx.actors.worker, 'POST', `/reservations/${reservationId}/dispatch`,
      { provider_key: 'kite', session_cap_minor: 15 });
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, 'PROVIDER_UNAVAILABLE');
    // the hold is untouched — still held, not dispatched
    const r = fx.db.prepare('SELECT state FROM reservations WHERE id = ?').get(reservationId) as any;
    assert.equal(r.state, 'held');
  } finally { fx.cleanup(); }
});

// Over-cap dispatch is refused before any external call.
test('dispatch over the session cap is refused', async () => {
  const fx = await httpFixture();
  try {
    const { reservationId } = await heldJob(fx);
    const res = await fx.api(fx.actors.worker, 'POST', `/reservations/${reservationId}/dispatch`,
      { provider_key: 'emulator', session_cap_minor: 10 });
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, 'AMOUNT_EXCEEDS_CAP');
  } finally { fx.cleanup(); }
});
