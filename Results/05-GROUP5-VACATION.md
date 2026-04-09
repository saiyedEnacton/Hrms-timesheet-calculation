# Group 5 — Vacation Tracking
**Result: 30/30 PASSED**

## Why This Test Group Exists

Vacation is the most visible benefit to employees and the most common source of HR disputes. This group proves every edge case in vacation tracking:
- Taking a day off deducts from balance; sick/accident days do not
- Public holidays inside a vacation period don't consume vacation days
- Half-days work correctly
- Year-end carryover applies the cap
- Negative balance (advance leave) is possible and reversible
- Part-time employees lose 1 full day (not 0.8 days) per vacation day taken
- Pro-rata for mid-year hires is calculated correctly
- Cross-year vacations split correctly across Dec 31

## Console Output

```
── 5.1 Vacation Day Reduces Balance ──────────────────
  ✅ Max starting balance = 24 days (23 + 3 carryover - 2 used in seed)
  ✅ Balance reduced by 2 after logging 2 vacation days
  ✅ Reduction is exactly 2 days

── 5.2-5.3 Sick / Accident / Dayoff — Vacation Unchanged ────
  ✅ Sick day does not reduce vacation balance
  ✅ Accident day does not reduce vacation balance
  ✅ Dayoff does not reduce vacation balance
  ✅ Sick entry stored correctly
  ✅ Accident entry stored correctly

── 5.4 Public Holiday During Vacation Week ───────────
  ✅ Easter Monday stored as public-holiday, not vacation
  ✅ Only 4 vacation days deducted (not 5)

── 5.5 Half-Day Vacation (4h = 0.5 days) ─────────────
  ✅ Half-day deducts 0.5 days
  ✅ Entry stores 4 hours

── 5.6 Carryover Cap on Year Rollover ────────────────
  ✅ Anna 2026 carryover capped at 5 (not 18.4)
  ✅ Cap comes from policy max_carryover_days = 5

── 5.7 Negative Balance — Advance Leave ──────────────
  ✅ Balance can go negative with advance leave
  ✅ Negative balance = -7 days
  ✅ Reversal restores balance

── 5.8 Vacation Payout (Days → Cash) ─────────────────
  ✅ Payout reduces vacation balance by 3 days
  ✅ Payout record stored with correct type
  ✅ Payout amount is negative (debit)

── 5.9 Part-Time: Entitlement Prorated, Day Unit Same ────
  ✅ Anna (80%) loses exactly 1 day for 1 vacation day
  ✅ Day deduction is same unit regardless of work%

── 5.10 Mid-Year Hire — Pro-Rata Entitlement ─────────
  ✅ Pro-rata entitlement = 7.7 days (23 × 4/12)
  ✅ Snapshot records hire_date trigger
  ✅ Snapshot records months remaining = 4

── 5.11 Cross-Year Vacation (Dec 30 – Jan 2) ─────────
  ✅ Dec 30-31 deducted from 2025 balance
  ✅ Jan 2 deducted from 2026 balance
  ✅ 2025 and 2026 balances are independent
  ✅ Dec entry stored with 2025 date
  ✅ Jan entry stored with 2026 date

════════════════════════════════════════════════════
  Results: 30 passed, 0 failed
  🎉 Group 5 passed! Vacation tracking is solid.
```

## What Each Section Proves

**5.1 — Vacation reduces balance:** Max starts with 26 days (23 entitlement + 3 carryover), minus 2 already used in seed data = 24 available. Each vacation entry deducts 1 day.

**5.2–5.3 — Non-vacation absences:** Sick, accident, and dayoff entries are stored as time entries with different `entry_type` but do NOT touch the vacation balance. This is legally critical — sick leave is a separate entitlement.

**5.4 — Holiday inside vacation week:** An employee books Mon–Fri as vacation. Monday is Easter Monday (public holiday). Only 4 vacation days are deducted, not 5 — the holiday is stored as `entry_type = public-holiday`, not vacation.

**5.5 — Half-day:** Taking 4 hours off deducts 0.5 days. The hours field stores 4, the balance deduction is 4/8 = 0.5.

**5.6 — Carryover cap:** Anna ends 2025 with 18.4 unused days. Policy cap is 5. Her 2026 carryover is 5, not 18.4. The cap is enforced at year rollover, not throughout the year.

**5.7 — Negative balance:** Sarah takes 30 days off when she only has 23 days. Balance goes to -7. This is "advance leave." The test then reverses it (+30 deduction) showing adjustments are the correction mechanism — no deletion of entries.

**5.8 — Payout:** When vacation days are paid out in cash (e.g. at termination), a `balance_adjustment` row is inserted with `adjustment_type = payout_vacation` and a negative amount. The original time entries are untouched.

**5.9 — Part-time day unit:** A full day of vacation is still 1 day regardless of contract percentage. Anna (80%) and Max (100%) both lose exactly 1 day for 1 vacation day. The difference is that Anna's entitlement is already prorated — she has 18.4 days vs Max's 23.

**5.10 — Pro-rata:** Sarah hired September 1. Months remaining = 4 (Sep, Oct, Nov, Dec). Entitlement = 23 × (4/12) = 7.666... → rounded to 7.7 days. Only the final result is rounded.

**5.11 — Cross-year:** A vacation spanning Dec 30 – Jan 2 creates separate entries per day. Dec 30 and Dec 31 deduct from the 2025 balance. Jan 2 deducts from the 2026 balance. The two years are completely independent.

## Summary

| Test | Scenario | Result |
|------|----------|--------|
| 5.1 | Vacation deducts correctly | ✅ PASS |
| 5.2–5.3 | Sick/accident/dayoff don't touch vacation | ✅ PASS |
| 5.4 | Holiday in vacation week saves a day | ✅ PASS |
| 5.5 | Half-day deducts 0.5 | ✅ PASS |
| 5.6 | Carryover cap enforced at rollover | ✅ PASS |
| 5.7 | Negative balance possible, reversible | ✅ PASS |
| 5.8 | Payout recorded as adjustment, not deletion | ✅ PASS |
| 5.9 | Part-time loses 1 day like full-time | ✅ PASS |
| 5.10 | Mid-year pro-rata rounded correctly | ✅ PASS |
| 5.11 | Cross-year split across Dec 31 | ✅ PASS |

**Total: 30/30 assertions passed**
