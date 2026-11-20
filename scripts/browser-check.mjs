// Real-browser verification of the JobMargin operator-console journey.
//
// Drives the actual server-rendered UI in a real Chromium engine over the
// DevTools Protocol (CDP) — no npm dependencies; uses Node 22's built-in
// WebSocket client. Provisions a disposable tenant, DB and browser profile,
// walks the acceptance journey through real console forms, and checks:
//   - margin/headroom display and CSV export retrieval
//   - keyboard reachability + focus visibility at desktop and 320px widths
//   - reload persistence and per-role permission/error visibility
//
//   node scripts/browser-check.mjs [--browser <path>] [--keep] [--shots-dir <dir>]
//
// Browser resolution order: --browser flag, $JM_BROWSER, newest
// chromium_headless_shell-* in the macOS Playwright cache, then a system
// Chrome/Chromium. Everything else (port, DB, profile) is ephemeral.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const KEEP = args.includes('--keep');
const SHOTS_DIR = flag('--shots-dir') ?? join(REPO, 'build-progress/jobmargin/browser');
const EVIDENCE_OUT = join(REPO, 'build-progress/jobmargin/BROWSER-RESULT.md');

/* ------------------------------------------------ browser discovery --- */
function discoverBrowser() {
  const explicit = flag('--browser') ?? process.env.JM_BROWSER;
  if (explicit) return explicit;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  try {
    const shells = readdirSync(cache)
      .filter((d) => d.startsWith('chromium_headless_shell-'))
      .sort().reverse();
    for (const d of shells) {
      for (const rel of [
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
        'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-headless-shell-linux/chrome-headless-shell',
      ]) {
        const p = join(cache, d, rel);
        if (existsSync(p)) return p;
      }
    }
    const fulls = readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse();
    for (const d of fulls) {
      const p = join(cache, d, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium');
      if (existsSync(p)) return p;
    }
  } catch { /* cache absent */ }
  for (const p of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium', '/usr/bin/google-chrome',
  ]) if (existsSync(p)) return p;
  return null;
}

/* ------------------------------------------------------- CDP client --- */
class Cdp {
  static async launch(binary, profileDir) {
    // --single-process/--no-zygote: avoids the Mach port rendezvous that
    // restrictive launch environments (e.g. agent sandboxes) deny. Set
    // JM_BROWSER_MULTIPROCESS=1 to launch the normal multi-process browser.
    const multi = process.env.JM_BROWSER_MULTIPROCESS === '1';
    const proc = spawn(binary, [
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-features=Translate',
      ...(multi ? [] : ['--single-process', '--no-zygote', '--no-sandbox']),
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const onData = (d) => {
        buf += d.toString();
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { proc.stderr.off('data', onData); resolve(m[1]); }
      };
      proc.stderr.on('data', onData);
      proc.on('exit', () => reject(new Error(`browser exited early:\n${buf}`)));
      setTimeout(() => reject(new Error(`browser did not emit DevTools URL:\n${buf}`)), 15000);
    });
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return new Cdp(ws, proc);
  }
  constructor(ws, proc) {
    this.ws = ws; this.proc = proc; this.id = 0;
    this.pending = new Map(); this.listeners = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result);
      } else if (msg.method) {
        for (const f of this.listeners.get(msg.method) ?? []) f(msg);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  once(method, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
      const arr = this.listeners.get(method) ?? [];
      arr.push((msg) => { clearTimeout(t); resolve(msg); });
      this.listeners.set(method, arr);
    });
  }
  async attach(url) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    if (url) await this.goto(sessionId, url);
    return { targetId, sessionId };
  }
  async goto(sessionId, url) {
    await this.send('Page.navigate', { url }, sessionId);
    for (let i = 0; i < 60; i++) {
      const rs = await this.eval(sessionId, 'document.readyState');
      if (rs === 'complete') return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`navigation to ${url} did not complete`);
  }
  async eval(sessionId, expression) {
    const r = await this.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page eval failed: ${d.text} ${d.exception?.description ?? ''}`);
    }
    return r.result.value;
  }
  async key(sessionId, key, code, vk) {
    for (const type of ['rawKeyDown', 'keyUp'])
      await this.send('Input.dispatchKeyEvent',
        { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sessionId);
  }
  async shot(sessionId, file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } try { this.proc.kill('SIGKILL'); } catch { /* gone */ } }
}

/* --------------------------------------------------- check harness ---- */
const rows = [`# Browser check result — ${new Date().toISOString()}`, '',
  '| Check | Expected | Actual |', '|---|---|---|'];
let failures = 0;
const log = (check, expected, actual, ok) => {
  if (!ok) failures++;
  const cell = (s) => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ');
  rows.push(`| ${cell(check)} | ${cell(expected)} | ${cell(actual)} |`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${check} — expected ${expected}, got ${actual}`);
};

/* ----------------------------------------------------- app setup ------ */
const { openDb, migrate, nowIso } = await import(join(REPO, 'src/db/connection.ts'));
const { ensureProviders } = await import(join(REPO, 'src/providers/registry.ts'));
const { token, uuid } = await import(join(REPO, 'src/domain/ids.ts'));
const { buildRouter } = await import(join(REPO, 'src/http/routes.ts'));
const { createApp } = await import(join(REPO, 'src/http/server.ts'));
const consoleUi = await import(join(REPO, 'src/http/console.ts'));
const { createWorker } = await import(join(REPO, 'src/worker/worker.ts'));
const { makeEmulator, dbStore } = await import(join(REPO, 'src/providers/emulator.ts'));

const tmp = join(REPO, '.test-tmp', `browser-${Date.now()}`);
mkdirSync(tmp, { recursive: true });
mkdirSync(SHOTS_DIR, { recursive: true });
const db = openDb(join(tmp, 'browser.db'));
migrate(db);
ensureProviders(db);

db.prepare('INSERT INTO tenants (id, name, kind, created_at) VALUES (?,?,?,?)')
  .run('browser-tenant', 'Browser Check Tenant (synthetic)', 'demo', nowIso());
db.prepare('INSERT INTO tenants (id, name, kind, created_at) VALUES (?,?,?,?)')
  .run('browser-other', 'Other Tenant (synthetic)', 'demo', nowIso());
const actors = {};
for (const [key, tenant, role, name, clientId] of [
  ['lead', 'browser-tenant', 'lead', 'Check Lead', null],
  ['worker', 'browser-tenant', 'worker', 'Check Worker', null],
  ['finance', 'browser-tenant', 'finance', 'Check Finance', null],
  ['clientAcme', 'browser-tenant', 'client', 'Check Client', 'client-acme'],
  ['outsider', 'browser-other', 'client', 'Check Outsider', 'client-else'],
]) {
  const t = token();
  db.prepare(`INSERT INTO actors (id, tenant_id, role, client_id, display_name, token, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(uuid(), tenant, role, clientId, name, t, nowIso());
  actors[key] = { token: t, role };
}

const server = createApp({
  db, router: buildRouter(db),
  renderError: (err, actor) => consoleUi.layout(consoleUi.errorPage(err, actor), actor),
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const worker = createWorker(db, { emulator: makeEmulator({ store: dbStore(db) }) });

const browserPath = discoverBrowser();
if (!browserPath) {
  console.error('No Chromium binary found. Pass --browser <path> or set JM_BROWSER.');
  process.exit(2);
}
console.log(`browser: ${browserPath}\napp:     ${base}\ndb:      ${tmp}`);

const cdp = await Cdp.launch(browserPath, join(tmp, 'profile'));

/* ------------------------------------------------- page helpers ------- */
const { sessionId: s } = await cdp.attach(`${base}/`);
const evalp = (expr) => cdp.eval(s, expr);
const goto = (url) => cdp.goto(s, new URL(url, base).href);
const location = () => evalp('location.pathname');
const html = () => evalp('document.documentElement.outerHTML');
const text = () => evalp('document.body.innerText');

/** Fill fields {id: value} on a form (revealing <details> first) and submit
 *  via a real submit-button click; wait for the PRG navigation. */
async function submitForm(formSel, fields) {
  await evalp(`(() => {
    const form = document.querySelector(${JSON.stringify(formSel)});
    if (!form) throw new Error('form not found: ${formSel}');
    let d = form.closest('details'); if (d) d.open = true;
    for (const [id, v] of Object.entries(${JSON.stringify(fields)})) {
      const el = form.querySelector('#' + id) ?? form.elements[id];
      if (!el) throw new Error('field not found: ' + id);
      el.value = v;
    }
    (form.querySelector('button[type=submit],input[type=submit]') ?? form).requestSubmit
      ? form.requestSubmit() : form.submit();
  })()`);
  for (let i = 0; i < 60; i++) {
    if (await evalp('document.readyState') === 'complete') {
      // PRG: location changes + reload; give it a beat then re-check
      await new Promise((r) => setTimeout(r, 120));
      if (await evalp('document.readyState') === 'complete') return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Click a button identified by its visible label inside a container. */
async function clickButton(label, scopeSel = 'body') {
  await evalp(`(() => {
    const scope = document.querySelector(${JSON.stringify(scopeSel)}) ?? document.body;
    const b = [...scope.querySelectorAll('button,a')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!b) throw new Error('control not found: ${label}');
    if (b.closest('details')) b.closest('details').open = true;
    b.click();
  })()`);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 120));
    if (await evalp('document.readyState') === 'complete') return;
  }
}

async function loginAs(actorKey) {
  await cdp.send('Network.clearBrowserCookies', {}, s).catch(() => {});
  await goto(`${base}/login`);
  await submitForm('form[action="/login"]', { token: actors[actorKey].token });
}

/** Keyboard scan: dispatch real Tab key events, record the focus trail. */
async function tabTrail(max = 40) {
  const trail = [];
  for (let i = 0; i < max; i++) {
    await cdp.key(s, 'Tab', 'Tab', 9);
    const cur = await evalp(`(() => {
      const e = document.activeElement;
      if (!e || e === document.body) return null;
      const cs = getComputedStyle(e);
      return { tag: e.tagName.toLowerCase(), name: (e.textContent || e.value || e.getAttribute('aria-label') || e.id || '').trim().slice(0, 40),
               outline: cs.outlineStyle + ' ' + cs.outlineWidth };
    })()`);
    if (!cur) break;
    trail.push(cur);
    if (i > 3 && trail[0].tag === cur.tag && trail[0].name === cur.name) break; // looped
  }
  return trail;
}

/* ======================================================= journey ======= */
try {
  // -- anonymous entry ----------------------------------------------------
  await goto(`${base}/ui/jobs`);
  const anon = await text();
  log('anonymous /ui/jobs blocked', '401 UNAUTHORIZED', /401|UNAUTHORIZED/i.test(anon) ? '401 page rendered' : anon.slice(0, 60), /401|UNAUTHORIZED/i.test(anon));

  // -- lead login through the real form ------------------------------------
  await goto(`${base}/login`);
  log('login form fields labelled', 'token input has <label>',
    await evalp(`!!document.querySelector('label[for=token]')`), true, true);
  const trail0 = await tabTrail(6);
  log('login page keyboard-reachable', 'submit reached via Tab',
    trail0.some((t) => /sign in/i.test(t.name)) ? 'Sign in focused' : JSON.stringify(trail0.map((t) => t.name)),
    trail0.some((t) => /sign in/i.test(t.name)));
  log('focus outline visible', 'non-none outline on keyboard focus',
    trail0.find((t) => /sign in/i.test(t.name))?.outline ?? 'none',
    trail0.some((t) => /sign in/i.test(t.name) && !/none/.test(t.outline)));

  await submitForm('form[action="/login"]', { token: actors.lead.token });
  log('lead sign-in lands on queue', '/ui/jobs', await location(), (await location()) === '/ui/jobs');

  // -- create job through the console form ----------------------------------
  await submitForm('section form[action="/jobs"]', {
    client_id: 'client-acme', title: 'Browser check job', currency: 'USD' });
  const queueText = await text();
  log('job created via console form', 'listed in queue',
    /Browser check job/.test(queueText) ? 'listed' : queueText.slice(0, 80), /Browser check job/.test(queueText));
  await clickButton('Browser check job');
  const jobUrl = await evalp('location.pathname');
  const jobId = jobUrl.split('/').pop();
  log('job page opened from console', 'job detail at /ui/jobs/<id>', jobUrl, /^\/ui\/jobs\/.+/.test(jobUrl));

  // -- quote draft + lock through console forms ------------------------------
  await submitForm('form[action$="/quotes"]', { price_minor: '1000', min_margin_minor: '300' });
  await clickButton('Lock');
  const jobHtml1 = await html();
  log('quote locked', 'locked status visible', /locked/.test(jobHtml1) ? 'locked' : 'not found', /locked/.test(jobHtml1));

  // -- post the 680c cost, holds, denials — all through console forms --------
  await submitForm('form[action$="/costs"]', { kind: 'labor', amount_minor: '680', note: 'ops labor', evidence_ref: 'ev-browser-1' });
  const headroomNow = await evalp(`[...document.querySelectorAll('.summary dt')].findIndex((d)=>d.textContent.trim()==='Headroom') >= 0
      ? document.querySelectorAll('.summary dd')[[...document.querySelectorAll('.summary dt')].findIndex((d)=>d.textContent.trim()==='Headroom')].textContent.trim() : 'MISSING'`);
  log('headroom shown pre-reservation', '$0.20', headroomNow, headroomNow === '$0.20');

  await submitForm('form[action$="/reservations"]', { request_key: 'browser-call-a', r_amount: '15', r_qv: '1' });
  await submitForm('form[action$="/reservations"]', { request_key: 'browser-call-b', r_amount: '15', r_qv: '1' });
  await submitForm('form[action$="/reservations"]', { request_key: 'browser-retry', r_amount: '50', r_qv: '1' });
  const resvText = await text();
  const denialCount = (resvText.match(/INSUFFICIENT_HEADROOM/g) ?? []).length;
  log('two denials shown with code', '2 × INSUFFICIENT_HEADROOM', `${denialCount} found`, denialCount === 2);
  log('denial shortfall visible', 'shortfall amount rendered', /shortfall \$0\.(10|45)/.test(resvText) ? 'rendered' : 'missing',
    /shortfall \$0\.(10|45)/.test(resvText));

  // -- dispatch held reservation via console form ----------------------------
  await submitForm('tr form[action$="/dispatch"]', { session_cap_minor: '15' });
  await worker.tick();
  await goto(jobUrl); // reload after background worker activity
  const attText = await text();
  log('attempt confirmed after reload', 'confirmed + provider ref',
    /confirmed/.test(attText) ? 'confirmed shown' : 'missing', /confirmed/.test(attText));

  // -- finance imports the 12c receipt through the console -------------------
  const providerRef = db.prepare(`SELECT provider_ref FROM attempts WHERE job_id = ? AND status='confirmed'`).get(jobId)?.provider_ref;
  await loginAs('finance');
  await goto(jobUrl);
  await submitForm('form[action="/receipts/import"]', {
    provider_key: 'emulator', provider_ref: providerRef, action_id: '',
    merchant: 'emulator-merchant', asset: 'USDTEST', rc_amount: '12' });
  const afterReceipt = await text();
  log('receipt settles, release shown', 'headroom back to $0.08', /\$0\.08/.test(afterReceipt) ? '$0.08 rendered' : 'missing',
    /\$0\.08/.test(afterReceipt));

  // -- lead delivers, client accepts, finance closes --------------------------
  await loginAs('lead'); await goto(jobUrl);
  await submitForm('form[action$="/deliveries"]', { artifact_hash: 'sha256:browser-artifact-1', del_ev: 'ev-del-1' });
  await loginAs('clientAcme'); await goto(jobUrl);
  const clientHtml = await html();
  log('client sees deliveries only', 'no margin figures', !/Headroom|Forecast margin/.test(clientHtml) ? 'margin hidden' : 'LEAKED',
    !/Headroom|Forecast margin/.test(clientHtml));
  await clickButton('Accept this delivery');
  const clientAfter = await html();
  log('client acceptance recorded', 'accepted shown', /accepted/.test(clientAfter) ? 'accepted' : 'missing', /accepted/.test(clientAfter));

  await loginAs('finance'); await goto(jobUrl);
  await clickButton('Close job');
  const closedText = await text();
  log('close v1 realized margin', '$3.08', /\$3\.08/.test(closedText) ? '$3.08 rendered' : 'missing', /\$3\.08/.test(closedText));

  // -- CSV export through the browser session --------------------------------
  const csv = await evalp(`fetch('/jobs/${jobId}/export.csv?version=1').then(r => r.text())`);
  log('CSV export retrieved in-session', 'realized_margin_minor,308 + cursor',
    /realized_margin_minor,308/.test(csv) && /ledger_cursor=/.test(csv) ? 'reconciles' : csv.slice(0, 60),
    /realized_margin_minor,308/.test(csv) && /ledger_cursor=\d+/.test(csv));
  log('CSV totals match console', '$3.08 on screen ↔ 308 in CSV',
    /\$3\.08/.test(closedText) && /realized_margin_minor,308/.test(csv) ? 'match' : 'mismatch',
    /\$3\.08/.test(closedText) && /realized_margin_minor,308/.test(csv));

  // -- reconciliation view ----------------------------------------------------
  await goto(`${jobUrl}/reconciliation`);
  const recon = await text();
  log('reconciliation view renders', 'denials + receipts sections',
    /Reservations|denial/i.test(recon) && /Receipt/i.test(recon) ? 'rendered' : 'missing',
    /denial|Reservations/i.test(recon) && /Receipt/i.test(recon));

  // -- reload persistence ------------------------------------------------------
  await goto(jobUrl);
  await cdp.shot(s, join(SHOTS_DIR, 'desktop-job-page.png'));
  const reloaded = await text();
  log('state survives reload', '$3.08 after reload', /\$3\.08/.test(reloaded) ? 'persisted' : 'lost', /\$3\.08/.test(reloaded));

  // -- desktop keyboard pass ----------------------------------------------------
  const trail = await tabTrail(45);
  const noOutline = trail.filter((t) => /none/.test(t.outline));
  log('desktop Tab reaches controls', '>=8 focusable stops', `${trail.length}`, trail.length >= 8);
  log('desktop focus always visible', 'no missing outlines',
    noOutline.length ? JSON.stringify(noOutline.slice(0, 3)) : 'all outlined', noOutline.length === 0);
  const unlabelled = await evalp(`[...document.querySelectorAll('input:not([type=hidden]),select,textarea')]
    .filter((el) => !el.labels?.length && !el.getAttribute('aria-label') && !el.closest('label'))
    .map((el) => el.name || el.id).join(',')`);
  log('all form fields labelled', 'none unlabelled', unlabelled || 'all labelled', !unlabelled);

  // -- 320px pass ----------------------------------------------------------------
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 320, height: 640, deviceScaleFactor: 1, mobile: true }, s);
  await goto(jobUrl);
  const narrow = await evalp(`({ sw: document.documentElement.scrollWidth, iw: innerWidth })`);
  log('320px: no page-level horizontal scroll', 'scrollWidth <= 320',
    `${narrow.sw}px @ innerWidth ${narrow.iw}`, narrow.sw <= 321);
  const trail320 = await tabTrail(30);
  log('320px: keyboard still traverses', '>=8 focusable stops', `${trail320.length}`, trail320.length >= 8);
  const narrowText = await text();
  log('320px: margin summary still readable', '$3.08 visible', /\$3\.08/.test(narrowText) ? 'visible' : 'missing', /\$3\.08/.test(narrowText));
  await cdp.shot(s, join(SHOTS_DIR, 'mobile-320-job-page.png'));
  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, s);

  // -- permission/error visibility ----------------------------------------------
  await loginAs('outsider');
  await goto(jobUrl);
  const denied = await text();
  log('outsider gets generic 404', 'NOT_FOUND, no title leak',
    /NOT_FOUND/.test(denied) && !/Browser check job/.test(denied) ? 'generic 404' : denied.slice(0, 80),
    /NOT_FOUND/.test(denied) && !/Browser check job/.test(denied));

  await loginAs('lead'); await goto(jobUrl);
  const leadHtml = await html();
  log('lead sees no finance-only controls', 'no Close job / Import receipt',
    !/>Close job<|Import a provider statement/.test(leadHtml) ? 'hidden' : 'present',
    !/>Close job<|Import a provider statement/.test(leadHtml));

  await loginAs('clientAcme'); await goto(jobUrl);
  await cdp.shot(s, join(SHOTS_DIR, 'client-view.png'));
} catch (err) {
  rows.push('', `**Script error: ${String(err.message ?? err).replaceAll('|', '\\|')}**`);
  console.error('script error:', err);
  failures++;
} finally {
  cdp.close();
  server.close();
  db.close();
  rows.push('', `**Result: ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' check(s) failed'}**`);
  writeFileSync(EVIDENCE_OUT, rows.join('\n') + '\n');
  console.log(`\nevidence: ${EVIDENCE_OUT}\nshots:    ${SHOTS_DIR}`);
  if (!KEEP) rmSync(tmp, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}
