# JobMargin

Fixed-price job margin ledger for AI operations agencies — one invoicing
currency per job, integer minor units, append-only journal, atomic budget
reservations, provider-bound dispatch with a durable outbox, receipt
reconciliation, customer acceptance and immutable close versions.

Zero-dependency build: Node.js ≥ 22.18 (native TypeScript stripping),
`node:sqlite`, `node:http`, `node:test`. No `npm install` step.

## Run

```sh
node src/migrate.ts            # apply migrations (JM_DB=data/jobmargin.db)
node src/seed.ts               # seed demo tenant + role tokens (demo data)
PORT=8080 node src/api.ts      # API + console on :8080
node src/worker.ts             # background worker (separate credentials/process)
# or embed: JM_EMBED_WORKER=1 node src/api.ts
```

Console: http://localhost:8080 → sign in with a seeded actor token.

## Test

```sh
node --test                    # all 34 tests (acceptance scene included)
node scripts/replay-pilot.mjs  # pilot replay → build-progress/jobmargin/PILOT-RESULT.md
```

## Layout

- `src/db/migrations/` — versioned schema (forward-migration tested)
- `src/domain/` — jobs, ledger, reservations, dispatch, receipts, delivery, reports
- `src/providers/` — seller adapter contract; local emulator + gated Kite adapter
- `src/worker/` — outbox worker: claim → execute once → finalize/uncertain
- `src/http/` — JSON API + server-rendered console
- `test/` — module tests T-001…T-016
- `fixtures/pilot/` — labelled synthetic pilot record
- `build-progress/jobmargin/` — handoff, status, pilot result
- `docs/build-pack/` — the supplied specification (immutable)
- `docs/decisions/` — stack decision record

## External gates

Kite Passport live paid execution is disabled: no recorded owner grant for
paid calls, no Passport session and no verified merchant/receipt lookup in
this build. The `kite` provider stays `live_enabled=0` and dispatch to it is
denied `PROVIDER_UNAVAILABLE`. See `docs/build-pack/KITE-AND-PROVIDERS.md`
and `build-progress/jobmargin/HANDOFF.md` for the exact missing proof.
