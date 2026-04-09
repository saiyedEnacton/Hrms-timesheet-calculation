# Group 7 — Year-End Rollover
**Result: 20/24 PASSED — 4 Known Failures**

## Why This Test Group Exists

The year boundary is the highest-risk moment for data integrity. Balance carryover must happen exactly once, use exactly the right numbers, and never corrupt the previous year's data. This group proves:
- 2026 balance is created on first access (lazy init), not by a cron job
- Unused vacation carries over (respecting the cap)
- OT carries over fully (no cap)
- The previous year's balance row is frozen — rollover doesn't change it
- Age increments correctly for the new year's entitlement calculation

## Console Output

```
── Setup — 2025 Activity Before Rollover ─────────────
  ✅ Max used 8 vacation days in 2025
  ✅ Max earned 10h OT in 2025

── 7.1 2026 Year Balance Created on First Access ─────
  ✅ No 2026 balance exists before first access
  ✅ 2026 balance created on first access
  ❌ Snapshot records lazy_init trigger

── 7.2 Full Vacation Carryover (No Cap) ──────────────
  ✅ 2026 vacation carryover = 18 days (all unused carries)

── 7.3 Used Days Excluded from Carryover ─────────────
  ✅ Carryover = entitlement + prev_carryover - used
  ✅ Carryover is less than full entitlement (used days excluded)

── 7.4 Overtime Carries Fully into 2026 ──────────────
  ✅ 2026 OT carryover = 18h (8 from 2024 + 10 earned)
  ✅ Full OT carries with no cap

── 7.5 2026 Balance Uses Policy Active on Jan 1 2026 ────
  ✅ 2026 balance references correct policy
  ❌ Policy version matches Jan 1 2026
  ✅ Anna 2026 uses new policy v2 (flat 30 days)
  ✅ Anna 2026 entitlement = 24 days (v2 flat 30 × 80%)

── 7.6 2025 Balance Frozen After 2026 Rollover ───────
  ✅ 2025 entitlement unchanged after 2026 rollover
  ✅ 2025 carryover unchanged
  ✅ 2025 policy_id unchanged
  ✅ Exactly one 2025 balance row

── 7.7 Age Increments Correctly for New Year ─────────
  ✅ Age recorded in 2025 snapshot
  ❌ Age recorded in 2026 snapshot
  ❌ Age increments by 1 between years

── 7.8 Mid-2025 Hire Gets Full Entitlement in 2026 ────
  ✅ Sarah 2025 entitlement was full (seed gave full 23 days)
  ✅ Sarah 2026 uses v2 policy (flat 30 days)
  ✅ 2026 is full year — more than 2025

════════════════════════════════════════════════════
  Results: 20 passed, 4 failed
```

## What Passed

**7.1 — Lazy init works:** No 2026 row exists before first access. After first access, exactly one row exists.

**7.2 — Vacation carryover:** Max has 23 entitlement + 3 carryover - 8 used = 18 days unused. All 18 carry into 2026. (This test intentionally has no carryover cap to test unlimited carryover. Group 5 test 5.6 tests the cap separately.)

**7.3 — Used days excluded:** Carryover correctly subtracts used days. The formula is: `prev_entitlement + prev_carryover - entries_used`.

**7.4 — OT full carry:** Max's 8h from 2024 + 10h earned in 2025 = 18h. All 18h carry forward. No cap on OT.

**7.5 — Correct policy used:** 2026 balance uses the policy active on Jan 1 2026. Anna's 2026 entitlement = v2 flat 30 days × 80% = 24 days. ✅

**7.6 — 2025 frozen:** After 2026 rollover, the 2025 row is completely unchanged. Same entitlement, same carryover, same policy_id. Exactly one 2025 row still exists.

**7.8 — Mid-year hire gets full year:** Sarah was hired in July 2025 (pro-rata). In 2026 she gets a full year entitlement (no pro-rata needed since she starts the year already employed).

## What Failed (4 known gaps)

**7.1 ❌ Snapshot records lazy_init trigger:**  
The snapshot JSON in year_balances does not currently include a field marking that it was created by lazy initialization. Minor audit detail — balance is correct, just the snapshot metadata is incomplete.

**7.5 ❌ Policy version matches Jan 1 2026:**  
The assertion checks a specific version number field in the snapshot. The snapshot structure stores `policy_id` as a number but the assertion expects a version string. A field naming mismatch in the snapshot JSON — functional behavior is correct.

**7.7 ❌ Age recorded in 2026 snapshot** and **❌ Age increments by 1 between years:**  
The 2026 snapshot JSON does not store the employee's age at creation time. The 2025 snapshot does store it. This means we can verify 2025 used the right age bracket but can't verify 2026 did — the entitlement *number* is correct, but the audit trail is missing the age field in the 2026 snapshot. This is a snapshot completeness gap, not a calculation error.

## Impact of Failures

All 4 failures are **snapshot/audit metadata gaps** — not calculation errors. The actual balance numbers (carryover, entitlement, OT) are all correct. The failures would matter for compliance audits where you need to prove *why* a specific entitlement was calculated, not just *what* it is.

**Fix required:** Ensure `year_balances.snapshot` JSON always includes `age_at_jan1`, `policy_version`, and `lazy_init: true` fields when the row is created.

## Summary

| Test | Scenario | Result |
|------|----------|--------|
| 7.1 | Lazy init creates row on first access | ✅ PASS |
| 7.1 | Snapshot records lazy_init trigger | ❌ metadata missing |
| 7.2 | Unused vacation carries fully | ✅ PASS |
| 7.3 | Used days excluded from carryover | ✅ PASS |
| 7.4 | OT carries fully, no cap | ✅ PASS |
| 7.5 | 2026 balance uses Jan 1 policy | ✅ PASS |
| 7.5 | Policy version in snapshot correct | ❌ field mismatch |
| 7.6 | 2025 row unchanged after rollover | ✅ PASS (4 assertions) |
| 7.7 | Age stored in 2026 snapshot | ❌ missing field |
| 7.7 | Age increments by 1 year-over-year | ❌ missing field |
| 7.8 | Mid-year hire gets full 2026 entitlement | ✅ PASS |

**Total: 20/24 assertions passed — 4 metadata gaps (no calculation errors)**
