# JobMargin · Reuse and evidence

The owner’s GitHub inventory and selected source files were reviewed on 20 November 2026. Each link below pins the reviewed revision. Inspect current target behavior, compatibility and license at intake. If private access is unavailable, implement the specified interface independently and record that choice. This pack contains no upstream source code or credentials.

### meterroom

Pinned baseline `062e73db4ab257fe9184c955cc569d42c0b480d9` (private). Reuse request and caller cost recording. Add a job ledger with quotes, reservations, acceptance, credits and cost allocation.

[server.ts](https://github.com/gnanam1990/meterroom/blob/062e73db4ab257fe9184c955cc569d42c0b480d9/packages/proxy/src/server.ts) · [ledger.ts](https://github.com/gnanam1990/meterroom/blob/062e73db4ab257fe9184c955cc569d42c0b480d9/packages/proxy/src/ledger.ts)

### flowops

Pinned baseline `c0431c67b62d069ee300773fd2549c64d746667b` (public). Adapt settlement and reconciliation outcomes to purchased job inputs. Decide who absorbs a failed delivery and reconcile late outcomes.

[ascp_settlement.go](https://github.com/gnanam1990/flowops/blob/c0431c67b62d069ee300773fd2549c64d746667b/cmd/control-plane-api/ascp_settlement.go) · [reconciliation_outcomes.go](https://github.com/gnanam1990/flowops/blob/c0431c67b62d069ee300773fd2549c64d746667b/cmd/control-plane-api/reconciliation_outcomes.go)

### closeout-ledger

Pinned baseline `f6332140fd8887fbafa9c896274036b4e88572b8` (private). Allocation is a reference for dividing a shared expense across jobs. Specify rounding, late credits and unassigned costs.

[policy.ts](https://github.com/gnanam1990/closeout-ledger/blob/f6332140fd8887fbafa9c896274036b4e88572b8/packages/contracts/src/policy.ts) · [allocation.ts](https://github.com/gnanam1990/closeout-ledger/blob/f6332140fd8887fbafa9c896274036b4e88572b8/packages/core/src/allocation.ts)

## Project lineage

Hackathon Atlas surfaced [Bun](https://dorahacks.io/buidl/46371) as adjacent work. The user-approved project boundary is: Fixed-price jobs in one invoicing currency per job. Include quoted price, attributable labor and infrastructure, reserved third-party spend, settled expenses, shared cost allocations and credits. Use integer minor units and exact conversion rules. Start with USD and explicitly mapped USD-denominated test units. Exclude exchange-rate conversion in the pilot.

## External dependency

Attribution fails if large costs bypass the system. Record unattributed costs and separate booked revenue from expected revenue. Platform interfaces are documented in [provider notes](KITE-AND-PROVIDERS.md). Market demand, integration behavior, source data access and live payment authority require separate evidence.
