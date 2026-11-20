import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture, type HttpFixture } from './helpers.ts';

/** Build the acceptance-scene job: $10 quote, $3 floor, $6.80 posted cost → $0.20 headroom. */
async function sceneJob(fx: HttpFixture): Promise<string> {
  let res = await fx.api(fx.actors.lead, 'POST', '/jobs',
    { client_id: 'client-acme', title: 'ACME report', currency: 'USD' });
  const jobId = res.json.job_id as string;
  await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/quotes`, { price_minor: 1000, min_margin_minor: 300 });
  await fx.api(fx.actors.lead, 'POST', `/jobs/${jobId}/quotes/1/lock`);
  res = await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/costs`,
    { kind: 'labor', amount_minor: 680, note: 'attributable work' });
  assert.equal(res.status, 200);
  return jobId;
}

async function margin(fx: HttpFixture, jobId: string) {
  const res = await fx.api(fx.actors.lead, 'GET', `/jobs/${jobId}/margin`);
  assert.equal(res.status, 200);
  return res.json;
}

// T-005: with 20 cents headroom two concurrent 15-cent requests yield one
// approval and one denial.
test('T-005: two concurrent 15c reservations on 20c headroom → one held, one denied', async () => {
  const fx = await httpFixture();
  try {
    const jobId = await sceneJob(fx);
    const before = await margin(fx, jobId);
    assert.equal(before.headroom_minor, 20);

    // two simultaneous requests through the real HTTP entry point — the
    // single-writer transaction serializes them so only the first sees headroom
    const [r1, r2] = await Promise.all([
      fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/reservations`,
        { amount_minor: 15, quote_version: 1 }, { 'idempotency-key': 'call-a' }),
      fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/reservations`,
        { amount_minor: 15, quote_version: 1 }, { 'idempotency-key': 'call-b' }),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const states = [r1.json.reservation.state, r2.json.reservation.state].sort();
    assert.deepEqual(states, ['denied', 'held']);

    const denied = [r1.json, r2.json].find((r) => r.reservation.state === 'denied')!;
    assert.equal(denied.reservation.denial_code, 'INSUFFICIENT_HEADROOM');
    assert.equal(denied.reservation.shortfall_minor, 10); // needed 15, headroom was 5

    // INV-03: sum of approved holds (15) ≤ routed headroom at approval (20)
    const after = await margin(fx, jobId);
    assert.equal(after.open_holds_minor, 15);
    assert.equal(after.headroom_minor, 5);
  } finally { fx.cleanup(); }
});

// T-006: a reused key with a changed 15→18 cent amount returns conflict
// without altering the original hold.
test('T-006: reused key with different amount → 409 conflict, original hold intact', async () => {
  const fx = await httpFixture();
  try {
    const jobId = await sceneJob(fx);
    const first = await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/reservations`,
      { amount_minor: 15, quote_version: 1 }, { 'idempotency-key': 'key-1' });
    assert.equal(first.json.reservation.state, 'held');

    const changed = await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/reservations`,
      { amount_minor: 18, quote_version: 1 }, { 'idempotency-key': 'key-1' });
    assert.equal(changed.status, 409);
    assert.equal(changed.json.error.code, 'IDEMPOTENCY_CONFLICT');

    // identical replay returns the stored decision, not a new hold
    const replay = await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/reservations`,
      { amount_minor: 15, quote_version: 1 }, { 'idempotency-key': 'key-1' });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.reservation.id, first.json.reservation.id);
    assert.equal(replay.json.replayed, true);

    // exactly one 15-cent hold is open
    const m = await margin(fx, jobId);
    assert.equal(m.open_holds_minor, 15);
    assert.equal(m.open_holds.length, 1);
    assert.equal(m.open_holds[0].amount_minor, 15);
  } finally { fx.cleanup(); }
});

// Denial codes: $0.50 retry denied when headroom is $0.20 (acceptance scene).
test('denial reasons: oversized retry and stale quote version', async () => {
  const fx = await httpFixture();
  try {
    const jobId = await sceneJob(fx);
    let res = await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/reservations`,
      { amount_minor: 50, quote_version: 1 }, { 'idempotency-key': 'big' });
    assert.equal(res.json.reservation.state, 'denied');
    assert.equal(res.json.reservation.denial_code, 'INSUFFICIENT_HEADROOM');
    assert.equal(res.json.reservation.shortfall_minor, 30);

    res = await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/reservations`,
      { amount_minor: 15, quote_version: 9 }, { 'idempotency-key': 'stale' });
    assert.equal(res.json.reservation.denial_code, 'STALE_QUOTE_VERSION');
  } finally { fx.cleanup(); }
});

// Expiry releases only undispatched holds (state model).
test('expired held reservation auto-releases and frees headroom', async () => {
  const fx = await httpFixture();
  try {
    const jobId = await sceneJob(fx);
    const res = await fx.api(fx.actors.worker, 'POST', `/jobs/${jobId}/reservations`,
      { amount_minor: 15, quote_version: 1, ttl_seconds: 1 }, { 'idempotency-key': 'exp' });
    assert.equal(res.json.reservation.state, 'held');
    // backdate expiry into the past and run the expiry sweep
    fx.db.prepare(`UPDATE reservations SET expires_at = '2000-01-01T00:00:00Z'`).run();
    const { expireHolds } = await import('../src/domain/reservations.ts');
    const sysActor = { ...fx.actors.worker, id: 'system' };
    const n = expireHolds(fx.db, sysActor);
    assert.equal(n, 1);
    const m = await margin(fx, jobId);
    assert.equal(m.open_holds_minor, 0);
    assert.equal(m.headroom_minor, 20);
  } finally { fx.cleanup(); }
});
