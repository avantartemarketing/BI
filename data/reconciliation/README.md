# Units sold: the orders feed against the funnel

Queried 2026-09-24T19:17:10.242Z, orders and events from 2025-01-01. Written by etl/analysis/feeds_reconciliation.js.

| Measure | Units |
|---|---|
| Units paid, orders feed definition | 38423 |
| Funnel units, purchase events | 15589 |
| Funnel units, upstream export | 15589 |

| How the orders matched | Orders | Units paid | Funnel units |
|---|---|---|---|
| both, same units | 14580 | 15137 | 15137 |
| both, units differ | 313 | 468 | 452 |
| orders only | 19122 | 22818 | 0 |
| funnel only | 0 | 0 | 0 |

by_day.csv: 2742 rows. order_match.csv: 673 rows.
