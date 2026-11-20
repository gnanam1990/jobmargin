import type { DatabaseSync } from 'node:sqlite';
import type { Ctx } from './server.ts';
import type { Actor } from '../domain/authz.ts';
import * as jobs from '../domain/jobs.ts';

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
main { padding: 1rem; max-width: 60rem; }
table { border-collapse: collapse; width: 100%; margin: .75rem 0; }
th, td { border: 1px solid var(--line); padding: .35rem .5rem; text-align: left; font-size: .925rem; }
th { background: #f2f2f2; }
label { display: block; margin: .5rem 0 .15rem; font-size: .9rem; }
input, select, button { font: inherit; padding: .35rem .5rem; }
button { cursor: pointer; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 1px; }
.muted { color: var(--muted); }
.ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
.flash { border:1px solid var(--line); background:#f6f8ff; padding:.5rem .75rem; margin:.5rem 0; }
section { margin: 1.25rem 0; }
fieldset { border: 1px solid var(--line); margin: .75rem 0; }
.money { font-variant-numeric: tabular-nums; text-align: right; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
<header>
  <strong>JobMargin</strong>
  <nav><a href="/ui/jobs">Jobs</a></nav>
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
  // cookie validity is checked on the next request; throw to stop handler
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

export function jobPage(c: Ctx): string {
  const { job, quotes } = jobs.jobDetail(c.db, c.actor, c.params.id) as {
    job: Record<string, unknown>; quotes: Record<string, unknown>[];
  };
  const op = c.url.searchParams.get('op');
  const quoteRows = (quotes ?? []).map((q) =>
    `<tr><td>v${esc(q.version)}</td><td class="money">${money(q.price_minor as number, job.currency as string)}</td>
     <td class="money">${money(q.min_margin_minor as number, job.currency as string)}</td>
     <td>${esc(q.status)}</td>
     <td>${q.status === 'draft' ? `<form method="post" action="/jobs/${esc(job.id)}/quotes/${esc(q.version)}/lock" style="display:inline"><input type="hidden" name="_back" value="/ui/jobs/${esc(job.id)}"><button type="submit">Lock</button></form>` : ''}</td></tr>`).join('');
  return `<h1>${esc(job.title)}</h1>
${op ? `<p class="flash" role="status">Saved. Operation <code>${esc(op)}</code></p>` : ''}
<p>Status: <strong>${esc(job.status)}</strong> · Client: ${esc(job.client_id)} · Currency: ${esc(job.currency)}</p>
<section><h2>Quote versions</h2>
${(quotes ?? []).length ? `<table><thead><tr><th scope="col">Version</th><th scope="col">Price</th><th scope="col">Margin floor</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead><tbody>${quoteRows}</tbody></table>` : '<p class="muted">No quotes yet.</p>'}
${c.actor.role === 'owner' || c.actor.role === 'lead' ? `
<form method="post" action="/jobs/${esc(job.id)}/quotes">
<input type="hidden" name="_back" value="/ui/jobs/${esc(job.id)}">
<label for="price_minor">Price (cents)</label><input id="price_minor" name="price_minor" inputmode="numeric" required>
<label for="min_margin_minor">Margin floor (cents)</label><input id="min_margin_minor" name="min_margin_minor" inputmode="numeric" required>
<p><button type="submit">Draft quote</button></p></form>` : ''}
</section>`;
}

export function errorPage(err: { code: string; message: string; status: number }, actor: Actor | null): string {
  return `<h1>${err.status} — ${esc(err.code)}</h1>
<p>${esc(err.message)}</p>
<p><a href="/ui/jobs">Back to work queue</a></p>`;
}
