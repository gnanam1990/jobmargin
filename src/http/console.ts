import type { Ctx } from './server.ts';
import type { Actor } from '../domain/authz.ts';
import type { DatabaseSync } from 'node:sqlite';
import * as jobs from '../domain/jobs.ts';
import * as reports from '../domain/reports.ts';
import * as ledger from '../domain/ledger.ts';
import { listProviders } from '../providers/registry.ts';
import { listReceipts } from '../domain/receipts.ts';
import { notFound } from '../domain/errors.ts';

/** Minimal accessible console shell — semantic HTML, native controls. */
export function layout(body: string, actor?: Actor | null): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JobMargin</title>
<style>
:root { --fg:#1a1a1a; --muted:#555; --line:#c9c9c9; --accent:#0b5fff; --ok:#146c2e; --warn:#8a4b00; --bad:#a31212; }
* { box-sizing: border-box; }
body { font-family: system-ui, sans-serif; color: var(--fg); margin: 0; line-height: 1.45; }
header { border-bottom: 1px solid var(--line); padding: .75rem 1rem; display:flex; gap:1rem; align-items:baseline; flex-wrap:wrap; }
header a { color: var(--accent); }
main { padding: 1rem; max-width: 62rem; }
table { border-collapse: collapse; width: 100%; margin: .75rem 0; }
th, td { border: 1px solid var(--line); padding: .35rem .5rem; text-align: left; font-size: .9rem; }
th { background: #f2f2f2; }
label { display: block; margin: .5rem 0 .15rem; font-size: .9rem; }
input, select, button { font: inherit; padding: .35rem .5rem; }
button { cursor: pointer; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 1px; }
.muted { color: var(--muted); }
.ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
.flash { border:1px solid var(--line); background:#f6f8ff; padding:.5rem .75rem; margin:.5rem 0; }
section { margin: 1.25rem 0; }
.summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(9rem,1fr)); gap:.5rem; margin:.75rem 0; }
.summary div { border:1px solid var(--line); padding:.5rem; }
.summary dt { font-size:.8rem; color:var(--muted); } .summary dd { margin:0; font-weight:600; font-variant-numeric:tabular-nums; }
.money { font-variant-numeric: tabular-nums; text-align: right; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
<header>
  <strong>JobMargin</strong>
  <nav><a href="/ui/jobs">Jobs</a> · <a href="/ui/exceptions">Exceptions</a></nav>
  ${actor ? `<span class="muted">${esc(actor.display_name)} · ${esc(actor.role)}</span>` : '<a href="/login">Sign in</a>'}
</header>
<main>
${body}
</main>
</body>
</html>`;
}

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function money(minor: number | null | undefined, currency = 'USD'): string {
  if (minor === null || minor === undefined) return '—';
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${currency === 'USDTEST' ? 'T$' : '$'}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function backTo(jobId: string): string {
  return `<input type="hidden" name="_back" value="/ui/jobs/${esc(jobId)}">`;
}

export function home(c: Ctx): string {
  return `<h1>JobMargin</h1>
<p>Fixed-price job margin ledger for AI operations agencies.</p>
<p><a href="/login">Sign in</a> to reach your work queue.</p>`;
}

export function loginPage(): string {
  return `<h1>Sign in</h1>
<form method="post" action="/login">
  <label for="token">Actor token</label>
  <input id="token" name="token" type="password" required autocomplete="off">
  <p><button type="submit">Sign in</button></p>
</form>
<p class="muted">Pilot build: tokens are issued by the agency owner through the seed command.</p>`;
}

export function doLogin(c: Ctx): never {
  const tok = String(c.body.token ?? '');
  c.res.writeHead(303, {
    location: '/ui/jobs',
    'set-cookie': `jm_session=${encodeURIComponent(tok)}; Path=/; HttpOnly; SameSite=Lax`,
  });
  c.res.end();
  throw Object.assign(new Error('redirect'), { __redirect: true });
}

export function jobList(c: Ctx): string {
  const rows = jobs.listJobs(c.db, c.actor) as {
    id: string; client_id: string; title: string; currency: string; status: string; created_at: string;
  }[];
  const items = rows.map((j) =>
    `<tr><td><a href="/ui/jobs/${esc(j.id)}">${esc(j.title)}</a></td>
     <td>${esc(j.client_id)}</td><td>${esc(j.status)}</td><td>${esc(j.currency)}</td>
     <td>${esc(j.created_at.slice(0, 10))}</td></tr>`).join('');
  return `<h1>Work queue</h1>
${rows.length === 0 ? '<p class="muted">No jobs in scope.</p>' : `
<table><thead><tr><th scope="col">Job</th><th scope="col">Client</th><th scope="col">Status</th><th scope="col">Currency</th><th scope="col">Created</th></tr></thead>
<tbody>${items}</tbody></table>`}
${c.actor.role !== 'client' ? `
<section><h2>New job</h2>
<form method="post" action="/jobs">
<input type="hidden" name="_back" value="/ui/jobs">
<label for="client_id">Client</label><input id="client_id" name="client_id" required>
<label for="title">Title</label><input id="title" name="title" required>
<label for="currency">Currency</label>
<select id="currency" name="currency"><option>USD</option><option>USDTEST</option></select>
<p><button type="submit">Create job</button></p></form></section>` : ''}`;
}

/* ------------------------------------------------------------------ */

function q(c: DatabaseSync, sql: string, ...args: (string | number)[]) {
  return c.prepare(sql).all(...args) as Record<string, unknown>[];
}
function q1(c: DatabaseSync, sql: string, ...args: (string | number)[]) {
  return c.prepare(sql).get(...args) as Record<string, unknown> | undefined;
}

function operatorSections(c: Ctx, jobId: string, cur: string): string {
  const role = c.actor.role;
  const margin = reports.marginView(c.db, c.actor, jobId);
  const entries = ledger.ledgerEntries(c.db, jobId);
  const resv = q(c.db,
    `SELECT r.*, a.display_name AS owner FROM reservations r
     JOIN actors a ON a.id = r.created_by WHERE r.job_id = ? ORDER BY r.created_at`, jobId);
  const attempts = q(c.db,
    `SELECT * FROM attempts WHERE job_id = ? ORDER BY created_at`, jobId);
  const receipts = listReceipts(c.db, c.actor, jobId) as Record<string, unknown>[];
  const flags = q(c.db, `SELECT * FROM attribution_flags WHERE job_id = ? ORDER BY raised_at`, jobId);
  const closes = q(c.db, `SELECT * FROM close_versions WHERE job_id = ? ORDER BY version`, jobId);
  const providers = listProviders(c.db);
  const isLead = role === 'lead' || role === 'owner';
  const isWorker = role === 'worker' || role === 'lead';
  const isFinance = role === 'finance' || role === 'owner';

  const entryRows = entries.map((e) =>
    `<tr><td>${e.seq}</td><td>${esc(e.kind)}${e.reversal_of ? ` <span class="muted">(reverses #${e.reversal_of})</span>` : ''}</td>
     <td class="money">${money(e.amount_minor, cur)}</td>
     <td>${esc(e.source)}</td><td>${esc(e.note)}</td>
     <td>${isFinance && e.kind !== 'reversal' && !entries.some((x) => x.reversal_of === e.seq)
        ? `<form method="post" action="/jobs/${esc(jobId)}/costs/${e.seq}/reverse" style="display:inline">${backTo(jobId)}<button type="submit">Reverse</button></form>` : ''}</td></tr>`).join('');

  const flagRows = flags.map((f) =>
    `<tr><td>${esc(f.description)}</td><td>${f.status === 'open' ? '<span class="bad">open — attribution incomplete</span>' : 'resolved'}</td>
     <td>${f.status === 'open' && isFinance
        ? `<form method="post" action="/jobs/${esc(jobId)}/flags/${esc(f.id)}/resolve" style="display:inline">${backTo(jobId)}<button type="submit">Resolve</button></form>` : ''}</td></tr>`).join('');

  const resvRows = resv.map((r) => {
    const denial = r.state === 'denied'
      ? `<span class="bad">${esc(r.denial_code)}</span>${r.shortfall_minor !== null ? ` shortfall ${money(r.shortfall_minor as number, cur)}` : ''}` : '';
    const dispatchForm = r.state === 'held' && isWorker
      ? `<form method="post" action="/reservations/${esc(r.id)}/dispatch">${backTo(jobId)}
         <label for="prov-${esc(r.id)}">Provider</label>
         <select id="prov-${esc(r.id)}" name="provider_key">${providers.map((p) => `<option>${esc(p.key)}</option>`).join('')}</select>
         <label for="cap-${esc(r.id)}">Session cap (cents)</label>
         <input id="cap-${esc(r.id)}" name="session_cap_minor" inputmode="numeric" value="${r.amount_minor}">
         <button type="submit">Dispatch</button></form>` : '';
    return `<tr><td>${esc(r.request_key)}</td><td class="money">${money(r.amount_minor as number, cur)}</td>
      <td>${esc(r.state)} ${denial}</td><td>${esc(r.owner)}</td>
      <td>${esc(r.expires_at ?? '')}</td><td>${dispatchForm}</td></tr>`;
  }).join('');

  const attemptRows = attempts.map((a) =>
    `<tr><td>${esc(a.provider_key)}</td><td>${esc(a.merchant)}</td><td>${esc(a.rail)}</td>
     <td class="money">${money(a.amount_minor as number, cur)}</td><td>${esc(a.status)}</td>
     <td>${esc(a.provider_ref ?? '')}</td><td class="muted">${esc(a.last_error ?? '')}</td></tr>`).join('');

  const receiptRows = receipts.map((r) =>
    `<tr><td>${esc(r.provider_ref)}</td><td>${esc(r.merchant)}</td><td>${esc(r.asset)}</td>
     <td class="money">${money(r.amount_minor as number, cur)}</td><td>${esc(r.status)}</td><td>${esc(r.via)}</td></tr>`).join('');

  const closeRows = closes.map((cv) =>
    `<tr><td>v${esc(cv.version)}</td><td>${esc(cv.ledger_cursor)}</td>
     <td class="money">${money(cv.costs_minor as number, cur)}</td>
     <td class="money"><strong>${money(cv.realized_margin_minor as number, cur)}</strong></td>
     <td>${cv.completeness === 'complete' ? '<span class="ok">complete</span>' : '<span class="warn">incomplete</span>'}</td>
     <td><a href="/jobs/${esc(jobId)}/export.csv?version=${esc(cv.version)}">CSV</a></td></tr>`).join('');

  const deliveryRows = q(c.db,
    `SELECT d.*, ac.actor_id AS accepted_by, ac.accepted_at FROM deliveries d
     LEFT JOIN acceptances ac ON ac.delivery_id = d.id
     WHERE d.job_id = ? ORDER BY d.version`, jobId).map((d) =>
    `<tr><td>v${esc(d.version)}</td><td><code>${esc(d.artifact_hash)}</code></td>
     <td>${esc(d.evidence_ref ?? '')}</td>
     <td>${d.accepted_by ? `<span class="ok">accepted</span> ${esc(d.accepted_at)}` : '—'}</td></tr>`).join('');

  return `
<section><h2>Margin</h2>
<dl class="summary">
  <div><dt>Quoted price</dt><dd>${margin.quote ? money(margin.quote.price_minor, cur) : '—'}</dd></div>
  <div><dt>Margin floor</dt><dd>${margin.quote ? money(margin.quote.min_margin_minor, cur) : '—'}</dd></div>
  <div><dt>Net costs</dt><dd>${money(margin.net_costs_minor, cur)}</dd></div>
  <div><dt>Open holds</dt><dd>${money(margin.open_holds_minor, cur)}</dd></div>
  <div><dt>Headroom</dt><dd>${money(margin.headroom_minor, cur)}</dd></div>
  <div><dt>Forecast margin</dt><dd>${money(margin.forecast_margin_minor, cur)}</dd></div>
  <div><dt>Realized margin</dt><dd>${margin.realized_margin_minor !== null ? `<strong>${money(margin.realized_margin_minor, cur)}</strong>` : '— (unaccepted)'}</dd></div>
  <div><dt>Unknown costs</dt><dd>${(margin.open_flags as unknown[]).length} open flag(s)</dd></div>
</dl>
<p><a href="/ui/jobs/${esc(jobId)}/reconciliation">Reconciliation view</a></p></section>

<section><h2>Costs &amp; journal</h2>
${entries.length ? `<table><thead><tr><th scope="col">#</th><th scope="col">Kind</th><th scope="col">Amount</th><th scope="col">Source</th><th scope="col">Note</th><th scope="col">Action</th></tr></thead><tbody>${entryRows}</tbody></table>` : '<p class="muted">No journal entries.</p>'}
${isWorker || isFinance ? `
<details><summary>Post a cost</summary>
<form method="post" action="/jobs/${esc(jobId)}/costs">${backTo(jobId)}
<label for="kind">Kind</label><select id="kind" name="kind"><option>labor</option><option>infra</option>${isFinance ? '<option>credit</option>' : ''}</select>
<label for="amount_minor">Amount (cents)</label><input id="amount_minor" name="amount_minor" inputmode="numeric" required>
<label for="note">Note</label><input id="note" name="note">
<label for="evidence_ref">Evidence ref</label><input id="evidence_ref" name="evidence_ref">
<p><button type="submit">Post cost</button></p></form></details>
<details><summary>Flag a missing cost</summary>
<form method="post" action="/jobs/${esc(jobId)}/flags">${backTo(jobId)}
<label for="description">What is missing?</label><input id="description" name="description" required>
<p><button type="submit">Raise flag</button></p></form></details>` : ''}
${flags.length ? `<h3>Attribution flags</h3><table><thead><tr><th scope="col">Description</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead><tbody>${flagRows}</tbody></table>` : ''}
</section>

<section><h2>Reservations</h2>
${resv.length ? `<table><thead><tr><th scope="col">Request</th><th scope="col">Amount</th><th scope="col">State / denial</th><th scope="col">Owner</th><th scope="col">Expires</th><th scope="col">Dispatch</th></tr></thead><tbody>${resvRows}</tbody></table>` : '<p class="muted">No reservations.</p>'}
${isWorker ? `
<details><summary>New reservation</summary>
<form method="post" action="/jobs/${esc(jobId)}/reservations">${backTo(jobId)}
<label for="request_key">Idempotency key</label><input id="request_key" name="request_key" required>
<label for="r_amount">Amount (cents)</label><input id="r_amount" name="amount_minor" inputmode="numeric" required>
<label for="r_qv">Quote version</label><input id="r_qv" name="quote_version" inputmode="numeric" value="${margin.quote?.version ?? 1}">
<p><button type="submit">Reserve</button></p></form></details>` : ''}
${attempts.length ? `<h3>Attempts</h3><table><thead><tr><th scope="col">Provider</th><th scope="col">Merchant</th><th scope="col">Rail</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Provider ref</th><th scope="col">Error</th></tr></thead><tbody>${attemptRows}</tbody></table>` : ''}
</section>

<section><h2>Receipts</h2>
${receiptRows.length ? `<table><thead><tr><th scope="col">Provider ref</th><th scope="col">Merchant</th><th scope="col">Asset</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Via</th></tr></thead><tbody>${receiptRows}</tbody></table>` : '<p class="muted">No receipts.</p>'}
${isFinance ? `
<details><summary>Import a provider statement line</summary>
<form method="post" action="/receipts/import">${backTo(jobId)}
<label for="provider_key">Provider</label>
<select id="provider_key" name="provider_key">${providers.map((p) => `<option>${esc(p.key)}</option>`).join('')}</select>
<label for="provider_ref">Provider ref</label><input id="provider_ref" name="provider_ref" required>
<label for="action_id">Action id (optional)</label><input id="action_id" name="action_id">
<label for="merchant">Merchant</label><input id="merchant" name="merchant" required>
<label for="asset">Asset</label><input id="asset" name="asset" value="USDTEST" required>
<label for="rc_amount">Amount (cents)</label><input id="rc_amount" name="amount_minor" inputmode="numeric" required>
<p><button type="submit">Import receipt</button></p></form></details>` : ''}
</section>

<section><h2>Deliveries</h2>
${deliveryRows.length ? `<table><thead><tr><th scope="col">Version</th><th scope="col">Artifact hash</th><th scope="col">Evidence</th><th scope="col">Acceptance</th></tr></thead><tbody>${deliveryRows}</tbody></table>` : '<p class="muted">No deliveries.</p>'}
${isLead ? `
<form method="post" action="/jobs/${esc(jobId)}/deliveries">${backTo(jobId)}
<label for="artifact_hash">Artifact hash</label><input id="artifact_hash" name="artifact_hash" required>
<label for="del_ev">Evidence ref</label><input id="del_ev" name="evidence_ref">
<p><button type="submit">Deliver</button></p></form>` : ''}
</section>

<section><h2>Close versions</h2>
${closes.length ? `<table><thead><tr><th scope="col">Version</th><th scope="col">Journal cursor</th><th scope="col">Costs</th><th scope="col">Realized margin</th><th scope="col">Completeness</th><th scope="col">Export</th></tr></thead><tbody>${closeRows}</tbody></table>` : '<p class="muted">Not closed.</p>'}
${isFinance ? `
<form method="post" action="/jobs/${esc(jobId)}/close">${backTo(jobId)}
<p><button type="submit">Close job</button></p></form>` : ''}
</section>`;
}

function clientSections(c: Ctx, jobId: string): string {
  const dels = q(c.db,
    `SELECT d.*, ac.actor_id AS accepted_by, ac.accepted_at FROM deliveries d
     LEFT JOIN acceptances ac ON ac.delivery_id = d.id
     WHERE d.job_id = ? ORDER BY d.version`, jobId);
  const rows = dels.map((d) =>
    `<tr><td>v${esc(d.version)}</td><td><code>${esc(d.artifact_hash)}</code></td>
     <td>${d.accepted_by ? `<span class="ok">accepted</span> ${esc(d.accepted_at)}` :
        `<form method="post" action="/deliveries/${esc(d.id)}/accept" style="display:inline">${backTo(jobId)}<button type="submit">Accept this delivery</button></form>`}</td></tr>`).join('');
  return `<section><h2>Your deliveries</h2>
${dels.length ? `<table><thead><tr><th scope="col">Version</th><th scope="col">Artifact</th><th scope="col">Acceptance</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="muted">Nothing delivered yet.</p>'}</section>`;
}

export function jobPage(c: Ctx): string {
  const { job } = jobs.jobDetail(c.db, c.actor, c.params.id) as { job: Record<string, unknown> };
  const op = c.url.searchParams.get('op');
  const cur = String(job.currency);
  const quotes = q(c.db,
    `SELECT * FROM quote_versions WHERE job_id = ? ORDER BY version`, c.params.id);
  const quoteRows = c.actor.role === 'client' ? '' : quotes.map((qt) =>
    `<tr><td>v${esc(qt.version)}</td><td class="money">${money(qt.price_minor as number, cur)}</td>
     <td class="money">${money(qt.min_margin_minor as number, cur)}</td><td>${esc(qt.status)}</td>
     <td>${qt.status === 'draft' && (c.actor.role === 'lead' || c.actor.role === 'owner')
        ? `<form method="post" action="/jobs/${esc(job.id)}/quotes/${esc(qt.version)}/lock" style="display:inline">${backTo(String(job.id))}<button type="submit">Lock</button></form>` : ''}</td></tr>`).join('');

  return `<h1>${esc(job.title)}</h1>
${op ? `<p class="flash" role="status">Saved. Operation <code>${esc(op)}</code></p>` : ''}
<p>Status: <strong>${esc(job.status)}</strong> · Client: ${esc(job.client_id)} · Currency: ${esc(cur)}</p>
${c.actor.role === 'client' ? '' : `
<section><h2>Quote versions</h2>
${quotes.length ? `<table><thead><tr><th scope="col">Version</th><th scope="col">Price</th><th scope="col">Margin floor</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead><tbody>${quoteRows}</tbody></table>` : '<p class="muted">No quotes yet.</p>'}
${(c.actor.role === 'owner' || c.actor.role === 'lead') ? `
<form method="post" action="/jobs/${esc(job.id)}/quotes">${backTo(String(job.id))}
<label for="price_minor">Price (cents)</label><input id="price_minor" name="price_minor" inputmode="numeric" required>
<label for="min_margin_minor">Margin floor (cents)</label><input id="min_margin_minor" name="min_margin_minor" inputmode="numeric" required>
<p><button type="submit">Draft quote</button></p></form>` : ''}
</section>`}
${c.actor.role === 'client' ? clientSections(c, c.params.id) : operatorSections(c, c.params.id, cur)}`;
}

export function reconPage(c: Ctx): string {
  if (c.actor.role === 'client') throw notFound();
  const v = reports.reconciliationView(c.db, c.actor, c.params.id);
  const cur = String(v.job.currency);
  const resvRows = (v.reservations as Record<string, unknown>[]).map((r) =>
    `<tr><td>${esc(r.request_key)}</td><td>${esc(r.owner)}</td><td>${esc(r.state)}</td>
     <td class="money">${money(r.amount_minor as number, cur)}</td>
     <td>${r.denial_code ? `${esc(r.denial_code)} shortfall ${money(r.shortfall_minor as number, cur)}` : ''}</td></tr>`).join('');
  const attRows = (v.attempts as Record<string, unknown>[]).map((a) =>
    `<tr><td>${esc(a.provider_key)}</td><td>${esc(a.status)}</td><td><code>${esc(a.provider_ref ?? '')}</code></td>
     <td class="money">${money(a.amount_minor as number, cur)}</td><td class="muted">${esc(a.last_error ?? '')}</td></tr>`).join('');
  const rcRows = (v.receipts as Record<string, unknown>[]).map((r) =>
    `<tr><td><code>${esc(r.provider_ref)}</code></td><td>${esc(r.merchant)}</td><td>${esc(r.asset)}</td>
     <td class="money">${money(r.amount_minor as number, cur)}</td><td>${esc(r.status)}</td><td>${esc(r.via)}</td></tr>`).join('');
  const exRows = (v.exceptions as Record<string, unknown>[]).map((e) =>
    `<tr><td>${esc(e.kind)}</td><td>${esc(e.status)}</td><td><code class="muted">${esc(e.detail_json)}</code></td></tr>`).join('');
  const unRows = (v.unallocated_statements as Record<string, unknown>[]).map((s) =>
    `<tr><td>${esc(s.source_ref)}</td><td>${esc(s.currency)}</td>
     <td class="money">${money(s.unallocated_minor as number, cur)}</td></tr>`).join('');
  const closeRows = (v.closes as Record<string, unknown>[]).map((cv) =>
    `<tr><td>v${esc(cv.version)}</td><td>${esc(cv.ledger_cursor)}</td>
     <td class="money">${money(cv.realized_margin_minor as number, cur)}</td><td>${esc(cv.completeness)}</td></tr>`).join('');
  return `<h1>Reconciliation — ${esc(v.job.title)}</h1>
<p><a href="/ui/jobs/${esc(v.job.id)}">Back to job</a></p>
<section><h2>Reservations &amp; denials</h2>
${resvRows ? `<table><thead><tr><th scope="col">Request</th><th scope="col">Owner</th><th scope="col">State</th><th scope="col">Amount</th><th scope="col">Denial</th></tr></thead><tbody>${resvRows}</tbody></table>` : '<p class="muted">None.</p>'}</section>
<section><h2>Attempts</h2>
${attRows ? `<table><thead><tr><th scope="col">Provider</th><th scope="col">Status</th><th scope="col">Provider ref</th><th scope="col">Amount</th><th scope="col">Error</th></tr></thead><tbody>${attRows}</tbody></table>` : '<p class="muted">None.</p>'}</section>
<section><h2>Receipts</h2>
${rcRows ? `<table><thead><tr><th scope="col">Provider ref</th><th scope="col">Merchant</th><th scope="col">Asset</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Via</th></tr></thead><tbody>${rcRows}</tbody></table>` : '<p class="muted">None.</p>'}</section>
<section><h2>Exceptions</h2>
${exRows ? `<table><thead><tr><th scope="col">Kind</th><th scope="col">Status</th><th scope="col">Detail</th></tr></thead><tbody>${exRows}</tbody></table>` : '<p class="muted">None.</p>'}</section>
<section><h2>Unallocated statement residual</h2>
${unRows ? `<table><thead><tr><th scope="col">Statement</th><th scope="col">Currency</th><th scope="col">Unallocated</th></tr></thead><tbody>${unRows}</tbody></table>` : '<p class="muted">None.</p>'}</section>
<section><h2>Close versions</h2>
${closeRows ? `<table><thead><tr><th scope="col">Version</th><th scope="col">Cursor</th><th scope="col">Margin</th><th scope="col">Completeness</th></tr></thead><tbody>${closeRows}</tbody></table>` : '<p class="muted">None.</p>'}</section>`;
}

export function exceptionsPage(c: Ctx): string {
  if (c.actor.role === 'client') throw notFound();
  const ex = q(c.db,
    `SELECT id, kind, detail_json, status, receipt_id, job_id, raised_at
     FROM exceptions WHERE tenant_id = ? ORDER BY raised_at DESC`, c.actor.tenant_id);
  const rows = ex.map((e) =>
    `<tr><td>${esc(e.kind)}</td><td>${esc(e.status)}</td>
     <td>${e.job_id ? `<a href="/ui/jobs/${esc(e.job_id)}">job</a>` : '—'}</td>
     <td><code class="muted">${esc(e.detail_json)}</code></td>
     <td>${e.status === 'open' ? `<form method="post" action="/exceptions/${esc(e.id)}/resolve" style="display:inline"><input type="hidden" name="_back" value="/ui/exceptions"><input name="note" placeholder="resolution note"><button type="submit">Resolve</button></form>` : ''}</td></tr>`).join('');
  return `<h1>Exceptions</h1>
${ex.length ? `<table><thead><tr><th scope="col">Kind</th><th scope="col">Status</th><th scope="col">Job</th><th scope="col">Detail</th><th scope="col">Action</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="muted">No exceptions.</p>'}`;
}

export function errorPage(err: { code: string; message: string; status: number }, actor: Actor | null): string {
  return `<h1>${err.status} — ${esc(err.code)}</h1>
<p>${esc(err.message)}</p>
<p><a href="/ui/jobs">Back to work queue</a></p>`;
}
