# Group 3 — Contract Change (Full-Time ↔ Part-Time)
**Result: 28/28 PASSED**

## Why This Test Group Exists

Employees change their working hours — from 80% to 60%, full-time to part-time, etc. When this happens:
- Past entries must still show overtime calculated against the old contract
- Future entries use the new contract's threshold
- Year-end entitlement for the year the change happened is NOT recalculated (it was set at Jan 1)
- The new year's entitlement uses the contract active on Jan 1 of that year

This proves we can answer "why did Anna have more overtime in June than in March even though she worked the same hours?"

## Scenario

Anna Schmidt works at 80% (32h/week threshold) until May 31.  
From June 1, her contract changes to 60% (24h/week threshold).  
Same gross hours (8h/day). Different overtime because the threshold changed.

- **March (80%):** Daily threshold = 8 × 0.80 = 6.4h → 8h day → 1.6h OT
- **June (60%):** Daily threshold = 8 × 0.60 = 4.8h → 8h day → 3.2h OT

## Console Output

```
── Setup — Anna changes from 80% to 60% on 2025-06-01 ────
  ✅ Contract on 2025-05-15 = 80%
  ✅ Contract on 2025-06-15 = 60%
  ✅ Only one contract has effective_to = NULL
  ✅ Old 80% contract closed on 2025-05-31
  ✅ New 60% contract weekly target = 24h

── Old Entries Reflect 80% Contract ──────────────────
  ✅ Anna March entry exists (from seed)
  ✅ March entry references policy v1
  ✅ March entry hours = 8

── New Entries Reflect 60% Contract ──────────────────
  ✅ Anna June entry exists
  ✅ June OT = 3.2h (60% threshold applied)
  ✅ June regular = 4.8h

── Same Hours, Different OT Due to Contract Change ────
  ✅ March 20 OT = 1.6h (80% threshold)
  ✅ June 2 OT = 3.2h (60% threshold)
  ✅ Same gross hours (8h), different OT

── 2025 Year Balance Unchanged After Contract Switch ────
  ✅ Anna 2025 entitlement still 18.4 days (80% at year start)
  ✅ Anna 2025 balance policy still v1

── 2026 Year Balance — Lazy Init Uses 60% Contract ────
  ✅ No 2026 balance before lazy init
  ✅ 2026 balance created
  ✅ 2026 entitlement = 13.8 days (23 × 60%)

── Point-in-Time Contract Queries ────────────────────
  ✅ Anna contract on 2025-01-01 = 80%
  ✅ Anna contract on 2025-05-31 = 80%
  ✅ Anna contract on 2025-06-01 = 60%
  ✅ Anna contract on 2025-12-31 = 60%
  ✅ Anna contract on 2026-03-01 = 60%

── Vacation Carryover 2025 → 2026 ────────────────────
  ✅ Anna 2026 vacation carryover capped at 5 days
  ✅ Anna 2026 OT carryover = 11.2h

── Data Integrity ────────────────────────────────────
  ✅ No employee has more than 1 open contract
  ✅ Every work entry has a matching contract on that date

════════════════════════════════════════════════════
  Results: 28 passed, 0 failed
  🎉 Group 3 passed! Contract versioning is solid.
```

## What Each Section Proves

**Contract versioning:** When the contract changes, the old row gets `effective_to = 2025-05-31`. A new row is inserted with `effective_from = 2025-06-01`. At any point in time, exactly one contract has `effective_to = NULL`.

**OT calculation by contract date:** The test logs two entries on different sides of the contract change — both with 8 gross hours. March gets 1.6h OT (80% threshold), June gets 3.2h OT (60% threshold). This is correct and auditable years later.

**2025 entitlement untouched:** Anna's 2025 entitlement was 18.4 days (23 × 80%), calculated on Jan 1 2025. The mid-year contract change does not touch this row.

**2026 entitlement uses new contract:** When 2026 is first accessed, entitlement is recalculated using the contract active on Jan 1 2026 — which is 60%. Result: 23 × 60% = 13.8 days.

**Point-in-time queries:** 5 different dates all return the correct contract percentage. The query pattern is the same as for policies: `effective_from <= date AND (effective_to IS NULL OR effective_to >= date)`.

**Carryover:** OT carryover = 11.2h reflects the overtime Anna earned under both contracts throughout 2025.

## Summary

| Test | Scenario | Result |
|------|----------|--------|
| Contract change closes old row | Only 1 open contract at all times | ✅ PASS |
| March OT = 1.6h at 80% | Old contract threshold applied | ✅ PASS |
| June OT = 3.2h at 60% | New contract threshold applied | ✅ PASS |
| Same hours, different OT | Contract change explains the difference | ✅ PASS |
| 2025 entitlement stays 18.4d | Year balance not retroactively changed | ✅ PASS |
| 2026 entitlement = 13.8d | New year uses current 60% contract | ✅ PASS |
| Point-in-time contract query | 5 dates all return correct % | ✅ PASS |
| Carryover correct | OT carryover reflects full year | ✅ PASS |
| Data integrity | No orphaned entries, no dual open contracts | ✅ PASS |

**Total: 28/28 assertions passed**
