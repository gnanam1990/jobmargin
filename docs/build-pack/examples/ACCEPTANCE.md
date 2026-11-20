# JobMargin · Demonstration script

**Input and expected outcome.** A $10.00 contract with a $3.00 margin floor and $6.80 attributable cost leaves $0.20. Two $0.15 parallel calls produce exactly one hold. A separate $0.50 retry is denied. A $0.12 actual charge against the winning hold leaves $0.08 headroom; after customer acceptance realized gross margin is $3.08.

**Operator surfaces.** Job page shows quoted price, margin floor, open holds, net costs, unknown costs and actual or forecast margin. A denial identifies the request and shortfall. Finance can inspect receipt provenance and export a versioned close; customer sees its own delivery only.

**Failure to demonstrate.** Use a durable dispatch outbox and broker action IDs. Reconciliation polls only an authorized provider's status mechanism. After an unknown result retry lookup, keep the hold and surface manual reconciliation where lookup is unavailable. Link expense reversals to original entries.

Create a labeled, rights-cleared sample through the import or creation UI. Identify the seeded input separately from all real actions and receipts. Record with two appropriate role sessions where required, browser refresh and worker restart. Use a final export or read-only case view tied to the input revision; show any unsupported capabilities as such. Record actual outcomes next to expected outcomes in the target repo.
