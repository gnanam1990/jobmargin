# JobMargin · Session handoff

Initial state: specification supplied. Greenfield dedicated repo; stack decision
recorded in docs/decisions/0001-stack.md (zero-dep Node 22 + node:sqlite).

- Target repository / branch / tested SHA: jobmargin / devin/jobmargin / see latest commit
- Current module and owner: M02 (implementation agent)
- Completed behavior and redacted evidence path:
  - M01 Job contracts and identity — DONE (T-001, T-002 + INV-01 + forward-migration test, 5/5 pass)
    - `node --test` → pass 5, fail 0 at the M01 commit
- Working tree or branch requiring transfer: none
- Commands, exit codes and tested environment:
  - `node --version` → v22.23.1 (native TS stripping, node:sqlite experimental warning only)
  - `npm test` / `node --test` → exit 0, 5 tests
  - `npm run migrate` → applies src/db/migrations/*.sql
  - `npm run seed` → seeds demo tenant + role tokens (demo data only)
  - `npm start` → API+console on :8080
- External dependencies and decisions:
  - Kite Passport paid execution: BLOCKED — no owner grant for paid calls in this
    run, no Passport session, no verified merchant/receipt lookup. Provider stays
    gated (docs/build-pack/KITE-AND-PROVIDERS.md); record exact missing proof at M04.
  - Postgres: not provisioned on this host → SQLite baseline (decision 0001).
- First next action: M02 — ledger_entries + manual costs + shared allocation
  (migration 0003), prove T-003/T-004.
- Next agent must reproduce: `node --test` (expect all tests passing at HEAD).
