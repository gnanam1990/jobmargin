# JobMargin · Session handoff

Greenfield dedicated repo; stack decision in docs/decisions/0001-stack.md
(zero-dep Node 22 + node:sqlite — no provisioned Postgres on this host).

- Target repository / branch / tested SHA: jobmargin / devin/jobmargin /
  see `testedSha` in STATUS.json (updated at each module commit).
- Current module and owner: all locally feasible modules accepted; next work
  requires external authority (see below).
- Completed behavior and redacted evidence path:
  - M01 job contracts & identity — T-001, T-002, INV-01, fwd-migration ✔
  - M02 cost attribution — T-003 (2,2,1), T-004 (dedupe), INV-02, reversals ✔
  - M03 reservations & concurrency — T-005 (one held/one denied), T-006
    (idempotency conflict), denial codes, expiry ✔
  - M04 paid call dispatch — T-007 (ref persisted), T-008 (crash → uncertain →
    resolved, one charge), claimed-reap, provider gate, over-cap ✔
  - M05 receipt reconciliation — T-009 (12↔15 release 3, replay no-op),
    T-010 (merchant/asset exceptions), INV-05 webhook+import once ✔
  - M06 delivery & close — T-011 (308 on 692), T-012 (re-acceptance),
    INV-06, post-close v2 ✔
  - M07 console & exports — T-013 (CSV = on-screen 308), T-014 (incomplete
    close visible), redacted client view ✔
  - M08 restart & pilot proof — T-015 (restart → same 308), T-016 (unresolved
    hold shown), two-worker single charge, late receipt, pilot replay ✔
- Working tree or branch requiring transfer: none (all committed).
- Commands, exit codes and tested environment:
  - `node --version` → v22.23.1 (macOS arm64; node:sqlite warns
    "experimental" but is functional)
  - `node --test` → exit 0, 34 tests pass
  - `node scripts/replay-pilot.mjs` → exit 0 → PILOT-RESULT.md (all expected
    outcomes observed through HTTP + UI)
  - `node src/migrate.ts` / `node src/seed.ts` / `node src/api.ts` /
    `node src/worker.ts` — normal entry points; JM_DB, PORT, JM_EMBED_WORKER,
    JM_EMULATOR_MODE, JM_WEBHOOK_SECRET envs.
- External dependencies and decisions:
  - kite-passport-live — BLOCKED (outside this run's authority):
    missing proof = (1) owner grant covering seller+rail+amount+purpose,
    (2) a Passport session for this agent, (3) verified merchant support and
    receipt/status lookup for the chosen merchant. Provider row
    `kite` stays `live_enabled=0`; dispatch denies PROVIDER_UNAVAILABLE;
    adapter fails closed. Everything else routes through the labelled local
    emulator merchant (`emulator`, USDTEST→USD 1:1).
  - Postgres — not provisioned (`role "postgres" does not exist`) → SQLite
    baseline (decision 0001).
  - meterroom / closeout-ledger private sources — unavailable; interfaces
    implemented independently per SOURCES.md guidance.
- First next action: none pending locally. To unblock live integration:
  obtain the three proofs above, implement execute/status in
  src/providers/kite.ts against the session API, set live_enabled=1, and
  re-run the T-007/T-008 paths with `provider_key=kite`.
- Next agent must reproduce: `node --test` (34 pass at HEAD) and
  `node scripts/replay-pilot.mjs` (all expected outcomes).
