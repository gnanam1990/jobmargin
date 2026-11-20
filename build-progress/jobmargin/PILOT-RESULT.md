# Pilot replay result — pilot-sample-001

Record: `SYNTHETIC PILOT SAMPLE — rights-cleared fixture, no real customer data. Replayable through the normal HTTP and UI entry points.`

| Step | Expected | Actual |
|---|---|---|
| create job | 200 | 200 |
| quote 1000/300 | draft v1 | v1 |
| lock quote | locked | locked |
| post 680c labor | posted | seq=1 |
| reserve pilot-call-a (15c) | held | held |
| reserve pilot-call-b (15c) | denied INSUFFICIENT_HEADROOM | denied INSUFFICIENT_HEADROOM shortfall=10 |
| reserve pilot-retry-50 (50c) | denied INSUFFICIENT_HEADROOM | denied INSUFFICIENT_HEADROOM shortfall=45 |
| dispatch 15c | queued | queued 576ae484 |
| worker tick | processes outbox | claimed=1 |
| import receipt 12c | settled release=3 | settled release=3 |
| deliver artifact | v1 | v1 |
| client accept | accepted | 200 |
| close v1 | margin=308 complete | margin=308 complete |
| console shows margin | \$3\.08 + Realized margin | rendered |

**Result: ALL EXPECTED OUTCOMES OBSERVED**
