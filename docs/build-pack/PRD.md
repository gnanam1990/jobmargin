# JobMargin · Product requirements

## Product decision

Fixed-price jobs in one invoicing currency per job. Include quoted price, attributable labor and infrastructure, reserved third-party spend, settled expenses, shared cost allocations and credits. Use integer minor units and exact conversion rules. Start with USD and explicitly mapped USD-denominated test units. Exclude exchange-rate conversion in the pilot.

**Buyer and commercial hypothesis.** AI operations agencies selling fixed-price work. Sell a team subscription plus metered completed jobs. First pilot with an agency willing to provide redacted cost and invoice records.

**People and responsibilities.** An agency owner defines the target gross margin. A project lead quotes and delivers the job. Workers incur expenses through scoped credentials. Finance matches statements and closes accepted jobs. Clients can accept only their own delivery.

## Customer journey

A lead locks a quote and budget, attaches the authorized session and routes a paid provider call through the worker. A retry competes with another reservation. Finance sees its eventual receipt alongside manual review costs. The client accepts the report and finance exports the reconciled job.

## Acceptance scene

A $10.00 contract with a $3.00 margin floor and $6.80 attributable cost leaves $0.20. Two $0.15 parallel calls produce exactly one hold. A separate $0.50 retry is denied. A $0.12 actual charge against the winning hold leaves $0.08 headroom; after customer acceptance realized gross margin is $3.08.

## Behaviors for the team

- **FR-01 · Job contracts and identity.** Persist tenants, operator/client roles, immutable quote revisions, currency and minimum gross margin. Bind the customer to a specific job and version.
- **FR-02 · Cost attribution.** Implement append-only direct labor, infra and provider expense entries and shared allocation. Surface the unallocated residual and evidence for adjustments.
- **FR-03 · Reservation and concurrency.** Build atomic job-budget reservation and denial reason codes. Validate quote revision, expiry and idempotency payload digest.
- **FR-04 · Paid call dispatch.** Bind the winning reservation to the payment-session cap, provider and rail. Persist a dispatch outbox before invoking the provider and save opaque provider references.
- **FR-05 · Receipt and credit reconciliation.** Ingest a provider statement, verify merchant and amount, replace the held estimate with the actual cost, and permit evidence-linked corrections.
- **FR-06 · Delivery and close.** Capture artifact digest, customer acceptance, realized revenue, expense completeness and immutable close versions. Permit post-close corrections via a new version.
- **FR-07 · Operator console and exports.** Expose denial shortfall, reservation owners, unallocated costs, acceptance and adjustment lineage. Generate per-job CSV and a reconciliation view.
- **FR-08 · Restart and pilot proof.** Implement recovery harness for two simultaneous workers, an ambiguous dispatch and a late receipt. Replay a consented pilot record through the normal HTTP and UI paths.

The [acceptance contract](CORE-CONTRACT.md) defines the fail/hold conditions for each requirement. Show the operator the responsible actor, decision reason, missing input and next possible action.

## Demand and release evidence

Start with one agency's consented historical cost and invoice pairs. Compare suggested rejections with actual requirements and include work that would have been delayed. Verify support for the chosen merchant, asset, allowance and receipt lookup before any authorized sandbox purchase.

Track completed cases over attempted cases, human exceptions, time to resolution and direct provider costs. Preserve the denominator and separate demonstration records from pilot records. Compare with the buyer's current manual workflow on the same cases. The adjacent Atlas project is [Bun](https://dorahacks.io/buidl/46371); customer willingness to pay requires pilot evidence.

## Larger team scope

- Approval delegation by currency and client, effective-dated margin policies, quotes with included usage
- Shared costs with deterministic remainder allocation, corrections and late credit notes
- Customer acceptance and dispute trails, cost imports with an unattributed queue
- Close-period comparisons, per-job variance explanations and replayable exports

These are product surfaces for a substantial team backlog. Size independently deliverable changes from real integrations, acceptance cases and findings. Around 500 meaningful commits is a scope preference. Actual change count follows the implementation.
