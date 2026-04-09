# Group 8 — Employee Lifecycle
**File:** `test-lifecycle.js` | **Result: 34/34 PASSED**

## Why This Test Group Exists

Employees are not static — they get hired mid-year, change roles, change contracts, get terminated, and sometimes come back. This group proves the schema handles every stage of an employee's journey without corrupting historical data or producing wrong balances.

Specific scenarios covered:
- Mid-month hire with pro-rata leave (not full-year entitlement)
- Termination closes contract + final settlement payout
- Rehire after a gap creates a new contract, not resurrecting the old one
- Historical entries remain queryable after termination
- Role changes don't touch contracts or balances
- Age bracket upgrade (turning 50) applies at year start, not on the birthday

## Console Output

```
── 8.1 Mid-Month Hire — Pro-Rata Leave ───────────────
  ✅ Julia balance created
  ✅ Pro-rata = 19.2 days (23 × 10/12)
  ✅ No carryover for new hire
  ✅ Snapshot records months_remaining = 10
  ✅ 2026 gets full 23 days (no pro-rata)
  ✅ 2026 carryover capped at 5

── 8.2 Rehire After Employment Gap ───────────────────
  ✅ Peter status = terminated
  ✅ Old contract closed on termination date
  ✅ No open contract during gap
  ✅ New contract active from Oct 1
  ✅ Peter status = active after rehire
  ✅ Rehire contract ≠ old contract

── 8.3 Termination — Final Settlement Payout ─────────
  ✅ Sarah used 3 vacation days
  ✅ Sarah unused = 20 days (23 entitlement - 3 used)
  ✅ Payout adjustment recorded
  ✅ Payout amount = -20 days
  ✅ Payout created_by = hr_admin
  ✅ Final balance = 0 after payout

── 8.4 Historical Data Survives Termination ──────────
  ✅ Sarah marked terminated
  ✅ Sarah entries still exist after termination
  ✅ Sarah year balance survives termination
  ✅ Payout adjustment survives termination
  ✅ Can query salary history from terminated employee

── 8.5 Role Change — No Balance Impact ───────────────
  ✅ Role updated to Manager
  ✅ Contract still 100% after role change
  ✅ Vacation entitlement unchanged
  ✅ OT carryover unchanged
  ✅ Time entries unchanged
  ✅ Role restored to Service

── 8.6 Age Bracket Change at 50 (Year Start Only) ────
  ✅ 2025: 23 days (age 48)
  ✅ 2026: 23 days (age 49, still under 50)
  ✅ 2027: 29 days (age 50, bracket upgrades)
  ✅ Bracket change uses age on Jan 1, not birthday mid-year
  ✅ 2025 and 2026 unchanged after 2027 created

════════════════════════════════════════════════════
  Results: 34 passed, 0 failed
  🎉 Group 8 passed! Employee lifecycle is solid.
```

## What Each Section Proves

**8.1 — Mid-month hire pro-rata:**  
Julia hired March 15 gets months_remaining = 10 (March counts as month 3, so 12 − (3−1) = 10). Entitlement = `round(23 × 10/12 × 10) / 10 = 19.2 days`. The snapshot records this for audit. In 2026 she gets the full 23 days — pro-rata only applies in the hire year.

**8.2 — Rehire after gap:**  
Peter is terminated June 30, rehired October 1. The termination closes the old contract (`effective_to = 2025-06-30`). Between June 30 and October 1 there is no open contract — any time entries in that window would correctly have no contract match. Rehire inserts a brand new contract row; the old one stays intact in history.

**8.3 — Final settlement:**  
Sarah has 23 days entitlement, used 3 vacation days before termination → 20 unused. A `payout_vacation` balance adjustment of -20 days is inserted by `hr_admin`. After the payout: entitlement (23) + adjustments (-20) - used (3) = 0. Clean close.

**8.4 — Historical data survives:**  
After Sarah is marked terminated, all her time entries, year balance, and payout adjustment are still fully queryable. Nothing is deleted. This is the immutable records principle — termination is a status change, not a data purge.

**8.5 — Role change is metadata only:**  
Max is promoted from Service to Manager. The `role` column on `employees` updates. The contract (100%), vacation entitlement (23 days), OT carryover (8h), and all 12 time entries are completely unchanged. Role is not a financial field — it has no balance impact.

**8.6 — Age 50 bracket upgrade:**  
Hans Bauer born June 15, 1976. On Jan 1 2025 he is 48 → 23 days. On Jan 1 2026 he is 49 → still 23 days. On Jan 1 2027 he is 50 → 29 days (50+ bracket). The bracket upgrade happens at the start of the year when he turns 50, not on his birthday mid-year. The 2025 and 2026 balances remain at 23 after 2027 is created — past balances are frozen.

## Summary

| Test | Scenario | Result |
|------|----------|--------|
| 8.1 | Mid-month hire pro-rata (19.2 = 23 × 10/12) | ✅ PASS |
| 8.1 | 2026 gets full year, carryover capped at 5 | ✅ PASS |
| 8.2 | Termination closes contract, no open contract during gap | ✅ PASS |
| 8.2 | Rehire creates new contract, old preserved | ✅ PASS |
| 8.3 | Final settlement: 20 unused days paid out | ✅ PASS |
| 8.3 | Balance = 0 after payout, formula verified | ✅ PASS |
| 8.4 | All data survives termination (no delete) | ✅ PASS |
| 8.5 | Role change does not affect contract or balances | ✅ PASS |
| 8.6 | Age 50 bracket applies on Jan 1, not birthday | ✅ PASS |
| 8.6 | Past years frozen after new year created | ✅ PASS |

**Total: 34/34 assertions passed**
