# JobMargin · Test plan

Every test begins NOT_RUN. [Registry](requirements.json) links each test to one module and its requirement. Run fast domain tests first, then real database/worker integration and normal browser entry points. External integration evidence states its environment and provider.

## Reference end-to-end acceptance

A $10.00 contract with a $3.00 margin floor and $6.80 attributable cost leaves $0.20. Two $0.15 parallel calls produce exactly one hold. A separate $0.50 retry is denied. A $0.12 actual charge against the winning hold leaves $0.08 headroom; after customer acceptance realized gross margin is $3.08.

Run from a clean checkout. Capture the action through the UI or supported API, restart at an uncertain boundary, inspect the recovered record with a second authorized session and export the allowed outcome. Verify a different tenant cannot access it. Exercise the chosen provider against an authorized sandbox/test environment; a local boundary emulator is suitable for deterministic fault injection. Qualify each result by environment.

## Module tests

### T-001 — Job contracts and identity • expected behavior

Status: NOT_RUN

A lead locks a 1000-cent quote with a 300-cent floor and a client can view its own job.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-002 — Job contracts and identity • failure boundary

Status: NOT_RUN

A client from another agency cannot read the quote or infer its price.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-003 — Cost attribution • expected behavior

Status: NOT_RUN

Distribute five cents equally across three stable job IDs as 2,2,1 cents under deterministic rounding.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-004 — Cost attribution • failure boundary

Status: NOT_RUN

A repeated source statement cannot create a second set of allocations.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-005 — Reservation and concurrency • expected behavior

Status: NOT_RUN

With 20 cents headroom two concurrent 15-cent requests yield one approval and one denial.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-006 — Reservation and concurrency • failure boundary

Status: NOT_RUN

A reused key with a changed 15-to-18-cent amount returns conflict without altering the original hold.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-007 — Paid call dispatch • expected behavior

Status: NOT_RUN

A 15-cent hold can dispatch one authorized request for that merchant and persist its reference.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-008 — Paid call dispatch • failure boundary

Status: NOT_RUN

A worker crash after external acceptance leaves an uncertain hold and no second payment after restart.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-009 — Receipt and credit reconciliation • expected behavior

Status: NOT_RUN

A 12-cent receipt against a 15-cent hold releases 3 cents; replay does not affect headroom.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-010 — Receipt and credit reconciliation • failure boundary

Status: NOT_RUN

A receipt in a different asset or with a mismatched merchant opens an exception.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-011 — Delivery and close • expected behavior

Status: NOT_RUN

Acceptance for the exact delivered hash computes 308 cents of gross margin on 692 cents of settled costs.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-012 — Delivery and close • failure boundary

Status: NOT_RUN

Replacing an artifact after acceptance invalidates its use as acceptance for the replacement.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-013 — Operator console and exports • expected behavior

Status: NOT_RUN

CSV for close v1 reconciles to the on-screen 308-cent gross margin.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-014 — Operator console and exports • failure boundary

Status: NOT_RUN

A missing review-cost record flagged by the lead makes the close incomplete and visible on export.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-015 — Restart and pilot proof • expected behavior

Status: NOT_RUN

Restart after reservation and before statement import; recovered job yields the same 308-cent final result.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-016 — Restart and pilot proof • failure boundary

Status: NOT_RUN

Absent external authorization or receipt lookup, keep the integration evidence conditional and show the unresolved hold.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.
