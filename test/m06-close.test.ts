import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture, type HttpFixture } from './helpers.ts';
import { createWorker } from '../src/worker/worker.ts';
import { makeEmulator, memStore } from '../src/providers/emulator.ts';

const HASH1 = 'sha256:deadbeef001-report';
const HASH2 = 'sha256:deadbeef002-report';

/** Full acceptance scene: settled 692¢ costs, delivered + accepted job. */
async function acceptedJob(fx: HttpFixture) {
  let res = await fx.api(fx.actors.lead, 'POST', '/jobs',
    { client_id: 'client-acme', title: 'ACME report', currency: 'USD' });
  const jobId = res.json.job_id as string;
  await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/quotes`, { price_minor: 1000, min_margin_minor: 300 });
  await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/quotes/1/lock`);
  await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/costs`, { kind: 'labor', amount_minor: 680 });
  res = await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/reservations`,
    { amount_minor: 15, quote_version: 1 }, { 'idempotency-key': 'call-1' });
  const reservationId = res.json.reservation.id as string;
  await fx.api(fx.actors.worker, 'POST', `/reservations/${reservationId}/dispatch`,
    { provider_key: 'emulator', session_cap_minor: 15 });
  const worker = createWorker(fx.db, { emulator: makeEmulator({ store: memStore() }) });
  await worker.tick();
  const attempt = fx.db.prepare('SELECT provider_ref FROM attempts WHERE reservation_id = ?')
    .get(reservationId) as { provider_ref: string };
  await fx.api(fx.actors.finance, 'POST', '/receipts/import', {
    provider_key: 'emulator', provider_ref: attempt.provider_ref,
    merchant: 'emulator-merchant', asset: 'USDTEST', amount_minor: 12,
  });
  res = await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/deliveries`,
    { artifact_hash: HASH1, evidence_ref: 'report-v1.pdf' });
  const deliveryId = res.json.delivery_id as string;
  res = await fx.api(fx.actors.clientAcme, 'POST', `/deliveries/${deliveryId}/accept`);
  assert.equal(res.status, 200);
  return { jobId, deliveryId };
}

// T-011: acceptance for the exact delivered hash computes 308 cents of
// gross margin on 692 cents of settled costs.
test('T-011: accepted job realizes 308c margin on 692c settled costs at close v1', async () => {
  const fx = await httpFixture();
  try {
    const { jobId } = await acceptedJob(fx);
    const m = await fx.api(fx.actors.lead, 'GET', `/jobs/${jobId}/margin`);
    assert.equal(m.json.realized_margin_minor, 308); // 1000 − 692

    const close = await fx.api(fx.actors.finance, 'POST', `/jobs/${jobId}/close`);
    assert.equal(close.status, 200, JSON.stringify(close.json));
    assert.equal(close.json.version, 1);
    assert.equal(close.json.completeness, 'complete');
    assert.equal(close.json.realized_margin_minor, 308);

    const closes = await fx.api(fx.actors.finance, 'GET', `/jobs/${jobId}/closes`);
    assert.equal(closes.json.closes.length, 1);
    assert.equal(closes.json.closes[0].costs_minor, 692);
    assert.equal(closes.json.closes[0].price_minor, 1000);
  } finally { fx.cleanup(); }
});

// T-012: replacing an artifact after acceptance invalidates its use as
// acceptance for the replacement.
test('T-012: replacement artifact needs its own acceptance before close', async () => {
  const fx = await httpFixture();
  try {
    const { jobId, deliveryId } = await acceptedJob(fx);

    // replace the artifact: job drops back to delivered
    let res = await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/deliveries`,
      { artifact_hash: HASH2, evidence_ref: 'report-v2.pdf' });
    const delivery2 = res.json.delivery_id as string;
    const job = await fx.api(fx.actors.lead, 'GET', `/jobs/${jobId}`);
    assert.equal(job.json.job.status, 'delivered');

    // close is refused: the v1 acceptance does not cover v2
    res = await fx.api(fx.actors.finance, 'POST', `/jobs/${jobId}/close`);
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'NOT_ACCEPTED');

    // accepting the superseded v1 is refused too
    res = await fx.api(fx.actors.clientAcme, 'POST', `/deliveries/${deliveryId}/accept`);
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'DELIVERY_SUPERSEDED');

    // accepting v2 restores accepted state and permits the close
    res = await fx.api(fx.actors.clientAcme, 'POST', `/deliveries/${delivery2}/accept`);
    assert.equal(res.status, 200);
    res = await fx.api(fx.actors.finance, 'POST', `/jobs/${jobId}/close`);
    assert.equal(res.status, 200);
    assert.equal(res.json.realized_margin_minor, 308);
  } finally { fx.cleanup(); }
});

// INV-06: an outstanding uncertain payment prevents a final reconciled close.
test('INV-06: uncertain reservation blocks close; wrong-client accept is a 404', async () => {
  const fx = await httpFixture();
  try {
    let res = await fx.api(fx.actors.lead, 'POST', '/jobs',
      { client_id: 'client-acme', title: 'ACME report', currency: 'USD' });
    const jobId = res.json.job_id as string;
    await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/quotes`, { price_minor: 1000, min_margin_minor: 300 });
    await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/quotes/1/lock`);
    res = await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/reservations`,
      { amount_minor: 15, quote_version: 1 }, { 'idempotency-key': 'unc-1' });
    const rid = res.json.reservation.id;
    fx.db.prepare(`UPDATE reservations SET state='uncertain' WHERE id=?`).run(rid);
    res = await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/deliveries`, { artifact_hash: HASH1 });
    const deliveryId = res.json.delivery_id;

    // a client bound to a different client_id gets a bare 404
    const outsider = await fx.api(fx.actors.outsiderClient, 'POST', `/deliveries/${deliveryId}/accept`);
    assert.equal(outsider.status, 404);

    await fx.api(fx.actors.clientAcme, 'POST', `/deliveries/${deliveryId}/accept`);
    res = await fx.api(fx.actors.finance, 'POST', `/jobs/${jobId}/close`);
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'UNRESOLVED_PAYMENTS');
  } finally { fx.cleanup(); }
});

// Post-close corrections are captured by a new close version.
test('post-close correction produces close v2 with a later cursor', async () => {
  const fx = await httpFixture();
  try {
    const { jobId } = await acceptedJob(fx);
    let res = await fx.api(fx.actors.finance, 'POST', `/jobs/${jobId}/close`);
    assert.equal(res.json.version, 1);
    const cursor1 = res.json.ledger_cursor;

    // late credit note: a correction lands after the close cursor
    res = await fx.api(fx.actors.finance, 'POST', `/jobs/${jobId}/costs`,
      { kind: 'labor', amount_minor: 30, note: 'late timesheet' });
    assert.equal(res.json.post_close, true);
    res = await fx.api(fx.actors.finance, 'POST', `/jobs/${jobId}/close`);
    assert.equal(res.status, 200);
    assert.equal(res.json.version, 2);
    assert.ok(res.json.ledger_cursor > cursor1);
    assert.equal(res.json.realized_margin_minor, 278); // 1000 − 722

    // no changes since → CLOSE_NO_CHANGE
    res = await fx.api(fx.actors.finance, 'POST', `/jobs/${jobId}/close`);
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'CLOSE_NO_CHANGE');
  } finally { fx.cleanup(); }
});
