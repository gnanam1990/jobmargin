# JobMargin · module index

These are dependency-ordered work units. Once a contract is agreed, UI, adapter and test contributors may proceed on fixtures matching that contract and integrate against its real implementation before acceptance.

1. [M01 · Job contracts and identity](prompts/M01.md) — Persist tenants, operator/client roles, immutable quote revisions, currency and minimum gross margin. Bind the customer to a specific job and version.
2. [M02 · Cost attribution](prompts/M02.md) — Implement append-only direct labor, infra and provider expense entries and shared allocation. Surface the unallocated residual and evidence for adjustments.
3. [M03 · Reservation and concurrency](prompts/M03.md) — Build atomic job-budget reservation and denial reason codes. Validate quote revision, expiry and idempotency payload digest.
4. [M04 · Paid call dispatch](prompts/M04.md) — Bind the winning reservation to the payment-session cap, provider and rail. Persist a dispatch outbox before invoking the provider and save opaque provider references.
5. [M05 · Receipt and credit reconciliation](prompts/M05.md) — Ingest a provider statement, verify merchant and amount, replace the held estimate with the actual cost, and permit evidence-linked corrections.
6. [M06 · Delivery and close](prompts/M06.md) — Capture artifact digest, customer acceptance, realized revenue, expense completeness and immutable close versions. Permit post-close corrections via a new version.
7. [M07 · Operator console and exports](prompts/M07.md) — Expose denial shortfall, reservation owners, unallocated costs, acceptance and adjustment lineage. Generate per-job CSV and a reconciliation view.
8. [M08 · Restart and pilot proof](prompts/M08.md) — Implement recovery harness for two simultaneous workers, an ambiguous dispatch and a late receipt. Replay a consented pilot record through the normal HTTP and UI paths.
