# JobMargin · Browser check

Real-browser verification of the operator-console journey over the Chrome
DevTools Protocol — **zero npm dependencies** (Node 22's built-in `WebSocket`
drives CDP directly). Provisions a disposable tenant, file DB, ephemeral port
and throwaway browser profile per run; no state survives unless `--keep`.

## Run it

```sh
node scripts/browser-check.mjs
```

Exit 0 = all checks passed. On exit it writes `BROWSER-RESULT.md` (redacted
evidence table) and PNG captures under `build-progress/jobmargin/browser/`.

### Options / environment

| Knob | Purpose | Default |
|---|---|---|
| `--browser <path>` | Chromium/Chrome binary | auto-discover (below) |
| `JM_BROWSER` | same, via env | — |
| `JM_BROWSER_MULTIPROCESS=1` | normal multi-process launch | off — runs `--single-process --no-zygote --no-sandbox`, which works where the Mach-port rendezvous is denied (e.g. agent sandboxes) |
| `--shots-dir <dir>` | screenshot output | `build-progress/jobmargin/browser` |
| `--keep` | keep disposable DB + profile | off |

### Browser discovery order

1. `--browser` / `JM_BROWSER`
2. Newest `chromium_headless_shell-*` in `~/Library/Caches/ms-playwright`
   (verified here: `chromium_headless_shell-1254`, "Chrome for Testing"
   158.0.8127.18)
3. Newest `chromium-*` in the same cache
4. System Chrome/Chromium (`/Applications/Google Chrome.app`, `/usr/bin/chromium`, …)

### Requirements

- Node ≥ 22.18 (built-in `WebSocket`, `node:sqlite`) — repo already requires it.
- Any Chromium-family binary with CDP (`--remote-debugging-port`).
- No npm install, no Playwright package — the CDP client is in the script.

## What it verifies

Journey driven through the **actual console forms** (not API injection):

- anonymous `/ui/jobs` → 401 page; lead sign-in via the login form → work queue
- create job → draft quote → lock → post 680¢ labor — all via console forms
- headroom shows **$0.20**; two parallel 15¢ reservations → one held, one
  `INSUFFICIENT_HEADROOM` (shortfall rendered); separate 50¢ retry → denied
- dispatch via console form → worker tick → **confirmed** attempt after reload
- finance imports the 12¢ provider statement line → headroom back to **$0.08**
- client session sees **deliveries only** (no margin figures), accepts via button
- finance closes → **realized margin $3.08** on screen; in-session CSV fetch
  returns `realized_margin_minor,308` bound to `ledger_cursor` — screen ↔ CSV match
- reconciliation view; reload persistence; outsider gets generic 404 (no title
  leak); lead sees no finance-only controls

Accessibility / layout (real `Tab` key events, computed styles):

- keyboard reaches ≥8 controls on job page at desktop and 320px
- every focused element shows a visible outline; every field is labelled
- 320px: no page-level horizontal scroll (`section { overflow-x:auto }`),
  margin summary still readable
- `prefers-reduced-motion` honored (stylesheet gate, T-014)

## Evidence

- `BROWSER-RESULT.md` — per-check expected vs actual table (latest run)
- `browser/desktop-job-page.png`, `mobile-320-job-page.png`, `client-view.png`

## Scope notes

- Local emulator provider only; the gated Kite adapter and all real-human
  gates (live grant/session/merchant proof) stay separate — see HANDOFF.md.
- Evidence contains only synthetic data; actor tokens are never printed.
