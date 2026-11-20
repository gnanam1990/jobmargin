# Browser check result — 2026-11-20T08:38:59.951Z

| Check | Expected | Actual |
|---|---|---|
| anonymous /ui/jobs blocked | 401 UNAUTHORIZED | 401 page rendered |
| login form fields labelled | token input has <label> | true |
| login page keyboard-reachable | submit reached via Tab | Sign in focused |
| focus outline visible | non-none outline on keyboard focus | solid 3px |
| lead sign-in lands on queue | /ui/jobs | /ui/jobs |
| job created via console form | listed in queue | listed |
| job page opened from console | job detail at /ui/jobs/<id> | /ui/jobs/f7465ef8-b165-45db-a5a9-2edf9aa9ba6e |
| quote locked | locked status visible | locked |
| headroom shown pre-reservation | $0.20 | $0.20 |
| two denials shown with code | 2 × INSUFFICIENT_HEADROOM | 2 found |
| denial shortfall visible | shortfall amount rendered | rendered |
| attempt confirmed after reload | confirmed + provider ref | confirmed shown |
| receipt settles, release shown | headroom back to $0.08 | $0.08 rendered |
| client sees deliveries only | no margin figures | margin hidden |
| client acceptance recorded | accepted shown | accepted |
| close v1 realized margin | $3.08 | $3.08 rendered |
| CSV export retrieved in-session | realized_margin_minor,308 + cursor | reconciles |
| CSV totals match console | $3.08 on screen ↔ 308 in CSV | match |
| reconciliation view renders | denials + receipts sections | rendered |
| state survives reload | $3.08 after reload | persisted |
| desktop Tab reaches controls | >=8 focusable stops | 10 |
| desktop focus always visible | no missing outlines | all outlined |
| all form fields labelled | none unlabelled | all labelled |
| 320px: no page-level horizontal scroll | scrollWidth <= 320 | 320px @ innerWidth 320 |
| 320px: keyboard still traverses | >=8 focusable stops | 13 |
| 320px: margin summary still readable | $3.08 visible | visible |
| outsider gets generic 404 | NOT_FOUND, no title leak | generic 404 |
| lead sees no finance-only controls | no Close job / Import receipt | hidden |

**Result: ALL CHECKS PASSED**
