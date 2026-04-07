# HRMS Schema Test Cases

All scenarios we need to validate for temporal data integrity.
Run order: `node schema.js && node seed.js && node test.js`

---

## GROUP 1 — Basic Schema & Seed (test.js — DONE ✅)

| # | Test | What it proves |
|---|------|----------------|
| 1.1 | All 7 tables exist | Schema was created correctly |
| 1.2 | 6 employees seeded | Seed ran without error |
| 1.3 | Max has active contract at 100% | Contract versioning works |
| 1.4 | Anna is 80%, Thomas is 60% | Part-time contracts stored correctly |
| 1.5 | Max: 23 days entitlement (age 28, 100%) | Age bracket lookup correct |
| 1.6 | Max: 3 days carryover from 2024 | Carryover stored in year_balances |
| 1.7 | Anna: 18.4 days entitlement (age 35, 80%) | Part-time proration of vacation |
| 1.8 | Peter: 29 days entitlement (age 52, 50+ bracket) | Upper age bracket |
| 1.9 | Lisa: 29 days entitlement (age 19, under-20 bracket) | Lower age bracket |
| 1.10 | Max has 12 entries (10 work + 2 vacation) | Time entry types stored |
| 1.11 | Work entry has overtime_hours stored | Calculations stored at entry time |
| 1.12 | Snapshot is valid JSON with policy_id | Snapshot freezes policy reference |
| 1.13 | Snapshot has calculation result | Snapshot captures how it was calc'd |
| 1.14 | Anna has 1 sick day entry | Non-work entry types work |
| 1.15 | Active policy exists, weekly_hours = 40 | Policy seeded correctly |
| 1.16 | Premium rates JSON parseable | JSON fields are valid |
| 1.17 | Overtime threshold = 40h, holiday = 100% | Policy values correct |
| 1.18 | Policy resolved for specific date | Point-in-time query works |
| 1.19 | Max vacation remaining = 24 days | Derived balance calculation correct |
| 1.20 | 10 Swiss holidays, Christmas exists | Holiday calendar correct |

---

## GROUP 2 — Policy Change Mid-Year (test-policy-change.js — TODO)

The core test: change rules, verify old data is untouched.

| # | Test | What it proves |
|---|------|----------------|
| 2.1 | Create overtime policy v2 effective July 2025 | New policy version inserted |
| 2.2 | Old entries (March 2025) still reference policy v1 | Immutability holds |
| 2.3 | New entries (Aug 2025) reference policy v2 | New rules applied going forward |
| 2.4 | Query Max's March overtime → still uses v1 threshold | Historical accuracy |
| 2.5 | Query Max's August overtime → uses v2 threshold | New rules applied correctly |
| 2.6 | No entries have NULL policy_id | Every entry has a policy reference |
| 2.7 | Only one policy has effective_to = NULL | No overlapping active policies |
| 2.8 | Age-based vacation → flat 25 days policy change | Different type of rule change |
| 2.9 | Employees hired before change use old vacation rule | Year balances frozen at year start |
| 2.10 | New year_balance for 2026 uses new policy | Year-start snapshot picks new rules |

---

## GROUP 3 — Employee Contract Change (test-contract-change.js — TODO)

Employee switches from full-time to part-time mid-year.

| # | Test | What it proves |
|---|------|----------------|
| 3.1 | Anna changes from 80% to 60% on June 1 2025 | New contract row inserted |
| 3.2 | Old contract has effective_to = 2025-05-31 | Old contract closed correctly |
| 3.3 | New contract has effective_to = NULL | New contract is active |
| 3.4 | Time entries before June still use 80% snapshot | Historical entries unchanged |
| 3.5 | Time entries after June carry 60% context | New contract reflected |
| 3.6 | Vacation entitlement recalculated pro-rata | Mid-year contract change handled |
| 3.7 | Overtime threshold changes with contract % | 80% = 32h threshold, 60% = 24h |
| 3.8 | Can query "what was Anna's contract on 2025-04-15?" | Point-in-time contract lookup |

---

## GROUP 4 — Premium Calculations (test-premiums.js — TODO)

Verify all premium rate types are stored correctly.

| # | Test | What it proves |
|---|------|----------------|
| 4.1 | Sunday work entry has sunday_premium > 0 | Sunday 100% premium calculated |
| 4.2 | Public holiday work entry has holiday_premium > 0 | Holiday 100% premium calculated |
| 4.3 | Night shift (23:00–06:00) has night_premium > 0 | Night 25% premium calculated |
| 4.4 | Normal weekday = 0 for all premiums | No false premium on regular day |
| 4.5 | Overtime entry: hours > 40h weekly threshold | Overtime tracked beyond threshold |
| 4.6 | Extratime entry: hours > 48h weekly threshold | Extratime at 25% above 48h |
| 4.7 | Premium rates in snapshot match policy at that date | Frozen correctly |
| 4.8 | Premium rate changes (100% → 50% sunday) | Old entries keep old rate in snapshot |
| 4.9 | Holiday that falls on Sunday: both premiums | Stacked premiums handled |
| 4.10 | Partial night shift (19:00–00:30): only night hours calculated | Partial overlap calculated |

---

## GROUP 5 — Vacation & Absence Tracking (test-vacation.js — TODO)

| # | Test | What it proves |
|---|------|----------------|
| 5.1 | Vacation day entry reduces remaining balance | vacation type counted correctly |
| 5.2 | Sick day does NOT reduce vacation balance | sick ≠ vacation |
| 5.3 | Accident day does NOT reduce vacation balance | accident ≠ vacation |
| 5.4 | Dayoff does NOT reduce vacation balance | dayoff ≠ vacation |
| 5.5 | Public holiday falls during vacation week | Holiday not counted as vacation day |
| 5.6 | Partial day vacation (4h = 0.5 days) | Half-day leave handled |
| 5.7 | Vacation carryover expires (max 5 days cap) | Carryover capped at year start |
| 5.8 | Negative vacation balance (advance leave) | balance_adjustment with negative amount |
| 5.9 | Vacation payout: days converted to cash | payout_vacation adjustment type |
| 5.10 | Part-time: 1 vacation day = proportional hours | 80% × 8h = 6.4h? or always 1 day? |
| 5.11 | Employee hired mid-year: pro-rata entitlement | Hire date affects vacation_entitlement |
| 5.12 | Cross-year vacation (Dec 29 – Jan 3) | Entries span two year_balances |

---

## GROUP 6 — Overtime & Compensation (test-overtime.js — TODO)

| # | Test | What it proves |
|---|------|----------------|
| 6.1 | Overtime accumulates across entries | Sum of overtime_hours correct |
| 6.2 | Overtime carryover from previous year | year_balances.overtime_carryover |
| 6.3 | Compensation day (overtime → free day) | entry_type = 'compensation' reduces OT |
| 6.4 | Compensation from current year OT | compensating current year hours |
| 6.5 | Compensation from previous year OT carryover | compensating carried-over hours |
| 6.6 | Overtime payout (hours → cash) | payout_overtime adjustment |
| 6.7 | Negative overtime balance (time deficit) | overtimeBalance can be negative |
| 6.8 | Manual overtime adjustment by admin | balance_adjustments.manual_overtime |
| 6.9 | Part-time OT threshold = contract hours not 40h | 80% employee OT starts at 32h/week |
| 6.10 | Weekly OT calc: 5 days × 8.5h = 2.5h OT | Weekly accumulation logic |

---

## GROUP 7 — Year-End Rollover (test-year-end.js — TODO)

| # | Test | What it proves |
|---|------|----------------|
| 7.1 | Create 2026 year_balance from 2025 end state | Year-start snapshot logic |
| 7.2 | Unused vacation carries over (max 5 days cap) | Carryover capped correctly |
| 7.3 | Vacation above cap is forfeited (not carried) | Excess not silently added |
| 7.4 | Overtime balance carries over to next year | OT carryover has no cap |
| 7.5 | New policy in 2026 applied to 2026 year_balance | Year snapshot uses active policy |
| 7.6 | 2025 year_balance is frozen after rollover | Old year data unchanged |
| 7.7 | Employee's age increments correctly for 2026 | Age-based vacation recalculated |

---

## GROUP 8 — Employee Lifecycle (test-lifecycle.js — TODO)

| # | Test | What it proves |
|---|------|----------------|
| 8.1 | New employee hired mid-month | Pro-rata leave for partial month |
| 8.2 | Employee rehired after gap | New contract, fresh balances |
| 8.3 | Employee terminated: final settlement | Remaining vacation paid out |
| 8.4 | Terminated employee entries still queryable | Historical data survives termination |
| 8.5 | Employee role change (same contract terms) | Role change doesn't affect balances |
| 8.6 | Employee turns 50 mid-year | Vacation bracket changes at next year-start |

---

## GROUP 9 — Edge Cases (test-edge-cases.js — TODO)

| # | Test | What it proves |
|---|------|----------------|
| 9.1 | Feb 29 on a leap year (2028) | Leap year date handling |
| 9.2 | Entry on Dec 31 and Jan 1 | Year boundary entries |
| 9.3 | Duplicate time entry rejected | UNIQUE constraint on (employee, date, type) |
| 9.4 | Time entry with no active policy | Must error, not silently proceed |
| 9.5 | Two policies with overlapping dates | Should be prevented / flagged |
| 9.6 | Entry type 'work' without clock_in/clock_out | Validation required |
| 9.7 | Employee with no year_balance for that year | Graceful handling |
| 9.8 | Snapshot JSON with future policy rules | Should not reference future policy |

---

## Running Order

```bash
# Reset everything
node schema.js && node seed.js

# Run tests in order
node test.js                    # Group 1 - basic (done)
node test-policy-change.js      # Group 2
node test-contract-change.js    # Group 3
node test-premiums.js           # Group 4
node test-vacation.js           # Group 5
node test-overtime.js           # Group 6
node test-year-end.js           # Group 7
node test-lifecycle.js          # Group 8
node test-edge-cases.js         # Group 9
```

Total test cases: **~90 across 9 groups**
