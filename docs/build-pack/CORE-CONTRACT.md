# JobMargin · acceptance contract

### FR-01 — Job contracts and identity

Persist tenants, operator/client roles, immutable quote revisions, currency and minimum gross margin. Bind the customer to a specific job and version.

### INV-01 — Job contracts and identity

One active quote version per job; its monetary unit never changes.

### FR-02 — Cost attribution

Implement append-only direct labor, infra and provider expense entries and shared allocation. Surface the unallocated residual and evidence for adjustments.

### INV-02 — Cost attribution

Allocated amounts plus unallocated balance equal each source statement in minor units.

### FR-03 — Reservation and concurrency

Build atomic job-budget reservation and denial reason codes. Validate quote revision, expiry and idempotency payload digest.

### INV-03 — Reservation and concurrency

Sum of approved holds never exceeds routed headroom at approval time.

### FR-04 — Paid call dispatch

Bind the winning reservation to the payment-session cap, provider and rail. Persist a dispatch outbox before invoking the provider and save opaque provider references.

### INV-04 — Paid call dispatch

Ambiguous provider outcomes cannot release spend capacity or trigger a new charge.

### FR-05 — Receipt and credit reconciliation

Ingest a provider statement, verify merchant and amount, replace the held estimate with the actual cost, and permit evidence-linked corrections.

### INV-05 — Receipt and credit reconciliation

A settled receipt changes net cost once across worker and webhook paths.

### FR-06 — Delivery and close

Capture artifact digest, customer acceptance, realized revenue, expense completeness and immutable close versions. Permit post-close corrections via a new version.

### INV-06 — Delivery and close

Actual profit requires accepted revenue; an outstanding uncertain payment prevents a final reconciled close.

### FR-07 — Operator console and exports

Expose denial shortfall, reservation owners, unallocated costs, acceptance and adjustment lineage. Generate per-job CSV and a reconciliation view.

### INV-07 — Operator console and exports

Report values agree with the same journal cursor used to produce the close.

### FR-08 — Restart and pilot proof

Implement recovery harness for two simultaneous workers, an ambiguous dispatch and a late receipt. Replay a consented pilot record through the normal HTTP and UI paths.

### INV-08 — Restart and pilot proof

A process restart preserves budget decisions, acceptance identity and journal totals.

### NFR-01 — Replayable evidence

A reviewer can reproduce the outcome from the exact input revision, actor scope, persisted decision and redacted evidence reference after a process restart.
