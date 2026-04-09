# Group 9 — Edge Cases & Data Integrity
**Result: 41/41 PASSED**

## Why This Test Group Exists

Edge cases are where systems break in production. This group specifically targets the scenarios that developers often forget to handle — leap years, year boundaries, constraint violations, future policy references, and graceful error handling. Every test here is based on a real class of production bug.

## Console Output

```
── 9.1 Leap Year — Feb 29 2028 ───────────────────────
  ✅ 2028 is a leap year
  ✅ 2025 is not a leap year
  ✅ 2100 is not a leap year
  ✅ 2000 is a leap year
  ✅ Feb 29 2028 entry accepted by SQLite
  ✅ Leap day entry stored and queryable
  ✅ Leap day entry date preserved exactly
  ✅ Leap year entries queryable by year

── 9.2 Year Boundary — Dec 31 / Jan 1 ────────────────
  ✅ Dec 31 entry stored
  ✅ Jan 1 entry stored
  ✅ Dec 31 in year 2025
  ✅ Jan 1 in year 2026
  ✅ Dec 31 references correct policy
  ✅ Jan 1 references correct policy
  ✅ Dec 31 counted in 2025 query
  ✅ Jan 1 counted in 2026 query

── 9.3 Duplicate Entry Rejected by UNIQUE Constraint ────
  ✅ First entry on 2025-11-03 accepted
  ✅ Duplicate entry rejected
  ✅ Error mentions UNIQUE constraint
  ✅ Original entry preserved after duplicate attempt

── 9.4 No Active Policy on Date — Blocked Before Insert ────
  ✅ Entry blocked when no policy active on date
  ✅ Error describes missing policy
  ✅ No entry written when policy missing

── 9.5 Overlapping Policies Detected by Integrity Check ────
  ✅ No overlapping policies in clean state
  ✅ Overlapping policy detected by integrity check
  ✅ Overlap detection returns both conflicting IDs
  ✅ No overlaps after removing bad policy

── 9.6 Work Entry Without Clock Times — Validation Blocks It ────
  ✅ Entry blocked with no clock_in
  ✅ Entry blocked with no clock_out
  ✅ Entry blocked with neither clock time
  ✅ Error mentions clock requirement
  ✅ No phantom entry written after failed validation

── 9.7 Missing Year Balance — Graceful Null Return ────
  ✅ Returns null (not crash) for missing year balance
  ✅ Safe function returns null for missing year
  ✅ Safe function returns value for existing year

── 9.8 Entry Cannot Reference Future Policy ──────────
  ✅ Policy lookup on 2025-08-01 does NOT return future policy
  ✅ Entry for Aug 2025 inserted ok
  ✅ Entry does not reference future policy v5
  ✅ Future policy resolves correctly for future date

── Final Integrity Check ─────────────────────────────
  ✅ No entries reference deleted policies
  ✅ No work entries missing clock times

════════════════════════════════════════════════════
  Results: 41 passed, 0 failed
  🎉 Group 9 passed! All edge cases handled.
```

## What Each Section Proves

**9.1 — Leap year:** Feb 29 only exists in leap years. The test verifies the leap year detection logic correctly handles: a normal leap year (2028), a non-leap year (2025), a century non-leap year (2100), and a 400-year rule leap year (2000). An actual Feb 29 entry is stored and retrieved without date corruption.

**9.2 — Year boundary:** Dec 31 and Jan 1 entries must be counted in their respective years. A query for "all 2025 entries" must include Dec 31 but not Jan 1. A query for "all 2026 entries" must include Jan 1 but not Dec 31. Both entries reference the correct policy version for their date.

**9.3 — Duplicate prevention:** The schema has `UNIQUE(employee_id, work_date, entry_type)`. Attempting to insert a second entry for the same employee + date + type is rejected at the database level. The original entry is preserved intact after the rejection.

**9.4 — Policy guard:** Before inserting any time entry, the code looks up the active policy for that date. If no policy exists for that date (e.g. a date before the first policy was created, or after all policies expired), the insert is blocked with a clear error. No orphaned entries with null policy_id are ever created.

**9.5 — Overlap detection:** An integrity check query can identify when two policy versions have overlapping date ranges for the same organization. Clean state returns no overlaps. Inserting a bad policy that overlaps is detected and flagged with both conflicting policy IDs. After removing the bad policy, the check returns clean again.

**9.6 — Clock time validation:** Work entries require both `clock_in` and `clock_out`. The validation runs before the database insert. Three scenarios all block: missing clock_in only, missing clock_out only, missing both. No phantom rows are written.

**9.7 — Graceful null:** When code requests a year balance for a year that doesn't exist yet, it returns `null` instead of throwing an exception. This is the correct behavior for lazy initialization — the caller decides whether to create it or not. The function also correctly returns a value when the year does exist.

**9.8 — Future policy isolation:** If a policy exists with `effective_from = 2026-01-01` (a future date), an entry for August 2025 must NOT pick up that future policy. The date-range query correctly returns only the policy active on the entry date. The future policy is correctly returned when queried for a 2026 date.

**Final integrity:** A pass-all check across the entire database confirms: no entries reference deleted policies, no work entries are missing their clock times.

## Summary

| Test | Scenario | Result |
|------|----------|--------|
| 9.1 | Leap year detection (4 cases) + Feb 29 storage | ✅ PASS |
| 9.2 | Dec 31 in 2025, Jan 1 in 2026 (8 assertions) | ✅ PASS |
| 9.3 | Duplicate rejected, original preserved | ✅ PASS |
| 9.4 | No policy on date blocks insert | ✅ PASS |
| 9.5 | Overlap detection finds and clears conflicts | ✅ PASS |
| 9.6 | Missing clock times block insert (3 scenarios) | ✅ PASS |
| 9.7 | Missing balance returns null, not crash | ✅ PASS |
| 9.8 | Future policy not picked up for past date | ✅ PASS |
| Final | No orphaned entries across entire DB | ✅ PASS |

**Total: 41/41 assertions passed**
