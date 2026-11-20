# Decision record

- Date: 2026-11-20
- Owner: implementation agent (this checkout)
- Affected module: all (project baseline)

## Decision

Greenfield stack: zero-dependency Node.js 22 (native TypeScript stripping,
erasable syntax only), `node:sqlite` file database in WAL mode with
`BEGIN IMMEDIATE` serializing transactions, `node:http` server-rendered
console, `node:test` suites. No npm dependencies — a clean checkout runs
`node src/migrate.ts`, `node src/api.ts`, `node src/worker.ts`,
`node --test` offline.

## Alternatives considered

- PostgreSQL per the TDD "proposed baseline": `psql` is installed but no
  server role exists (`role "postgres" does not exist`); provisioning one is
  outside this checkout's dependencies. SQLite preserves the same transactional
  guarantees (atomic multi-statement transactions, single-writer serialization)
  needed for INV-03 and restart proofs, and the schema is portable SQL.
- TypeScript toolchain via npm: requires registry access; native stripping
  on Node 22.18+ gives typed code with no install step.

## Dependency proof

- `node --version` → v22.23.1; `node -e "require('node:sqlite')"` works.
- `psql -h localhost` → `FATAL: role "postgres" does not exist` (no provisioned
  Postgres), recorded as the reason for the SQLite baseline.

## Conditions that reopen this decision

Owner provisions Postgres and asks to move; or `node:sqlite` limitations block
a required behavior (none observed for this scope).
