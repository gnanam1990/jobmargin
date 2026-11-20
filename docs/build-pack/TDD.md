# JobMargin · Technical design

## Architecture and ownership

Preserve an established target repo's stack and conventions. For a greenfield target the proposed baseline is a typed HTTP application, PostgreSQL, a supervised background worker and a role-aware web console. Use object storage for large evidence, opaque references in the database, and server-side authorization on retrieval. A transaction writes a domain decision and its outbox row together. A worker processes external side effects and stores a durable result independently of the browser session.

**Actors.** An agency owner defines the target gross margin. A project lead quotes and delivers the job. Workers incur expenses through scoped credentials. Finance matches statements and closes accepted jobs. Clients can accept only their own delivery.

## Domain schema

Tenant(id), Job(id,tenant_id,currency,quote_version), QuoteVersion(job_id,version,price_minor,min_margin_minor,status), Reservation(id,job_id,request_key,amount_minor,state,expires_at), Attempt(id,reservation_id,provider_key,session_ref,receipt_ref), LedgerEntry(id,job_id,kind,amount_minor,dedupe_key,reversal_of), Delivery(id,job_id,version,hash), Acceptance(delivery_id,actor_id,at), CloseVersion(job_id,version,ledger_cursor). Unique tenant/request_key and provider/receipt_ref. Journal entries are immutable.

Index tenant-scoped business keys, workflow status and pending work. Version migrations and test forward migration from a populated previous schema. Write quantities and currency using explicit units and integer minor or token units. Persist the precision alongside provider amounts. A comparison involving different currencies requires an explicit valuation source and timestamp.

## HTTP and worker boundaries

POST /jobs; POST /jobs/{id}/quotes; POST /jobs/{id}/reservations with Idempotency-Key; POST /reservations/{id}/dispatch; POST /receipts/import; POST /jobs/{id}/deliveries; POST /deliveries/{id}/accept; POST /jobs/{id}/close; GET /jobs/{id}/margin. Outsider reads return no resource details. POST /jobs/{id}/quotes/{version}/lock records a project lead’s authorized commercial commitment. Reservation reads that exact locked version.

Apply tenant membership and action scope on the server. Use a durable idempotency key on commands that can trigger work or payment. An identical retry returns the stored operation reference. A different payload under the same key yields a conflict. Keep polling and webhooks causally tied to the original operation. Apply provider signature verification when supported and reject unverified callbacks as evidence of settlement.

## Decision procedure

Inside one transaction lock the job and calculate headroom = locked quote price minus price credits, minimum margin, net attributable posted costs and open reservation balances. Consume each reservation once when committing matching expense. Refuse over-cap requests before external dispatch. An ambiguous dispatched payment continues occupying its reserved amount until reconciled. Report actual realized margin only after delivery acceptance. Record unpriced labor and external costs as incomplete attribution. Client delivery acceptance determines when actual revenue is recognized.

## State model

Quote draft → locked → superseded; reservation held → dispatched → settled or confirmed_void, with uncertain as a reconciled branch. Job open → delivered → accepted → closed; signed adjustments create a later close version. Expiry can auto-release only undispatched holds.

## Recovery

Use a durable dispatch outbox and broker action IDs. Reconciliation polls only an authorized provider's status mechanism. After an unknown result retry lookup, keep the hold and surface manual reconciliation where lookup is unavailable. Link expense reversals to original entries.

Use a compare-and-set version or row lock for conflicting decisions. Persist an intent before dispatch. If the provider cannot establish what happened, expose a pending-reconciliation state and stop automatic redispatch. Reconcile with the original provider reference, exact amount and scope. Maintain append-only corrections where users depend on the original evidence.

## Operations and integration

Record operation ID, actor role, decision code, latency and the external reference in access-controlled logs. Track stalled operations by age and surface them to the responsible role. Run migrations before workers, test a process restart during an in-flight request, and check convergence from an independently restored database. Deploy web and worker with separate credentials. See [the integration contract](KITE-AND-PROVIDERS.md) and [the tests](TEST-PLAN.md).
