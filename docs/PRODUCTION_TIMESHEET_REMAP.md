# Production Timesheet Remap
## Applying Proven Calculation Logic to SaasXPO Production Schema

**Date:** 2026-04-07  
**Purpose:** Our test schema validated every calculation edge case across 227 tests.  
This document tells developers exactly how to apply that logic to the production tables — no guessing, no drift.

---

## The Core Principle

Our test proved one thing above all:

> **Calculate once at submit time. Freeze everything. Never recalculate.**

Production already has the right columns for this. What it needs is the right logic filling them. That is what this document maps out.

---

## Table 1: `organization_timesheet_settings`

**Production has:** One row per organization. When admin changes a rule, the row gets updated in place. History is lost.

**What we need:** The same table, but treated as immutable versions. When a rule changes, close the old row and insert a new one.

### Schema addition needed

```sql
ALTER TABLE organization_timesheet_settings
  ADD COLUMN version          INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN effective_from   DATE    NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN effective_to     DATE,       -- NULL = currently active
  ADD COLUMN change_reason    TEXT,
  ADD COLUMN superseded_by    TEXT;       -- id of new version that replaced this
```

### How to read the active policy for any given date

```
Query: WHERE organization_id = ?
         AND effective_from <= target_date
         AND (effective_to IS NULL OR effective_to > target_date)
ORDER BY effective_from DESC
LIMIT 1
```

Never use `ORDER BY created_at DESC LIMIT 1`. Use the date range. That is the contract.

### How to change a policy

```
Step 1: Set effective_to = change_date - 1 day  on the current active row
        Set superseded_by = new row's id
Step 2: Insert new row with all updated values,
        effective_from = change_date,
        effective_to = NULL,
        version = previous_version + 1
```

Old time entries are unaffected because they carry snapshot columns (see Table 2).

### Vacation rules field

Production already stores `vacation_rules` as JSONB:
```json
[
  { "age_from": 18, "age_to": 19, "days": 29 },
  { "age_from": 20, "age_to": 49, "days": 23 },
  { "age_from": 50, "age_to": 999, "days": 29 }
]
```

This is correct. Read this array during entitlement calculation — do not hardcode age brackets in application code.

---

## Table 2: `organization_time_entry`

**Production has:** All the right columns. Snapshot columns exist. `calculation_context` JSONB exists.

**What it needs:** The right logic populating those columns at exactly the right moment.

### When to populate what

```
On CREATE (draft):
  - employee_id, organization_id, entry_date
  - entry_type (work | absence | adjustment)
  - entry_status = 'draft'
  - start_time, end_time, break_minutes
  - is_sunday     ← check if entry_date is Sunday (do this at creation, not submit)
  - is_public_holiday ← check organization_holiday table (do this at creation)
  - absence_type, absence_hours, is_paid_absence, counts_as_worked ← if absence

On SUBMIT (this is where all calculation happens):
  - hours_worked = (end_time - start_time) - break_minutes (in hours)
  - Fetch active policy: WHERE effective_from <= entry_date AND (effective_to IS NULL OR effective_to > entry_date)
  - Fetch employee's contract active on entry_date (from employment_history, see Table 4)
  - employee_workload_percent ← from that contract (frozen here)
  - expected_daily_hours = policy.default_daily_hours × (workload_percent / 100)
  
  Weekly overtime calculation (critical — see section below):
  - Sum hours_worked from all submitted/confirmed entries in the same ISO week for this employee
  - Including this entry
  - regular_hours_worked = min(hours_worked, what fits under weekly threshold)
  - overtime_hours = hours above policy.overtime_threshold_hours for the week
  - extratime_hours = hours above policy.extratime_threshold_hours for the week
  
  Premium hours (only for work entries, not absence):
  - sunday_premium_hours    = hours_worked if is_sunday else 0
  - holiday_premium_hours   = hours_worked if is_public_holiday else 0
  - night_shift_hours       = calculate overlap of (start_time, end_time) with (night_start_time, night_end_time)
  
  Freeze policy state into snapshots:
  - weekly_overtime_threshold_snapshot  = policy.overtime_threshold_hours
  - weekly_extratime_threshold_snapshot = policy.extratime_threshold_hours
  - overtime_rate_percent_snapshot      = policy.overtime_rate_percent
  - extratime_rate_percent_snapshot     = policy.extratime_rate_percent
  - sunday_premium_percent_snapshot     = policy.sunday_premium_percent
  - holiday_premium_percent_snapshot    = policy.holiday_premium_percent
  - night_premium_percent_snapshot      = policy.night_premium_percent
  
  Freeze calculation audit:
  - calculation_context = {
      policy_version: settings.version,
      policy_effective_from: settings.effective_from,
      employee_workload_percent: contract.workload_percentage,
      weekly_hours_before_this_entry: sum_before,
      weekly_hours_after_this_entry: sum_after,
      regular_hours: X,
      overtime_hours: X,
      premiums_applied: [...]
    }
  
  - entry_status = 'submitted'
  - submitted_at = now()
```

### Weekly overtime calculation — exact logic

This is where most bugs come from. The rule is weekly, not daily.

```
1. Get all entries for this employee in the same week (Mon 00:00 to Sun 23:59 of entry_date)
   that are in status submitted OR confirmed
   and entry_type = 'work'
   and deletion_phase = 'active'

2. Sum their hours_worked to get weekly_so_far (exclude current entry)

3. Add current entry's hours_worked → weekly_total

4. overtime_threshold  = policy.overtime_threshold_hours  (e.g. 40h)
   extratime_threshold = policy.extratime_threshold_hours (e.g. 48h)

5. hours_under_overtime  = min(weekly_total, overtime_threshold)  - weekly_so_far
   hours_under_extratime = min(weekly_total, extratime_threshold) - min(weekly_so_far, overtime_threshold)
   hours_extratime       = max(0, weekly_total - extratime_threshold) - max(0, weekly_so_far - extratime_threshold)

   regular_hours_worked = max(0, hours_under_overtime)
   overtime_hours       = max(0, min(weekly_total, extratime_threshold) - overtime_threshold
                              - max(0, weekly_so_far - overtime_threshold))
   extratime_hours      = max(0, hours_extratime)
```

Note: An 80% employee with `workload_percentage = 80` has `overtime_threshold = 40 × 0.80 = 32h`. Apply the percentage when computing the effective threshold for part-time employees. The stored threshold snapshot is the raw policy value — the workload adjustment happens in the calculation, stored in `calculation_context`.

### Night shift hours — exact logic

```
night_start = policy.night_start_time  (e.g. 23:00)
night_end   = policy.night_end_time    (e.g. 06:00)

The night window crosses midnight, so treat it as two windows:
  Window A: 23:00 → 24:00
  Window B: 00:00 → 06:00

Overlap of (entry start_time, entry end_time) with Window A and Window B gives night_shift_hours.

If an entry spans midnight (e.g. 22:00 to 06:00 next day):
  - This should be split into two time_entry rows at the business logic layer
  - OR handle it as a single entry that crosses midnight — document which approach is used and be consistent
```

### Immutability after confirmation

Once `entry_status = confirmed`:
- No field can be updated directly
- Corrections are new `entry_type = adjustment` rows
- The adjustment row carries negative hours to cancel, positive to add
- Both the original and the adjustment appear in history
- The sum of original + adjustments = effective value for that date

---

## Table 3: `organization_employee_annual_entitlement`

**Production has:** The right shape. `vacation_entitlement_hours` and `overtime_target_hours`, with `calculated_from_age` and `calculated_from_workload` for audit.

**What it needs:** Correct calculation and lazy initialization.

### Vacation entitlement — exact calculation

```
1. Get employee's date_of_birth from organization_employee
2. Calculate age as of January 1 of entitlement_year
   age = entitlement_year - birth_year
   If birthday is after Jan 1 (month > 1 or same month but day > 1): age - 1
3. Look up vacation_rules JSONB from organization_timesheet_settings
   Find the bracket where age_from <= age <= age_to → gives base_days
4. Apply workload:
   effective_days = base_days × (workload_percentage / 100)
   Round ONLY the final result: round(effective_days × 10) / 10
   !! Do NOT round intermediate values — this caused the 18.39999 bug in our tests
5. Convert to hours: vacation_entitlement_hours = effective_days × default_daily_hours
6. For mid-year hires: pro_rata = effective_days × (months_remaining_in_year / 12)
   months_remaining = 12 - (hire_month - 1)
   e.g. hired March 1: months_remaining = 10, months_remaining/12 = 0.833
   Apply rounding only after full multiplication
```

### Lazy initialization

```
When any API request needs an employee's balance for a year:
  IF no row exists in organization_employee_annual_entitlement for (employee_id, year):
    → Calculate it now using the formula above
    → INSERT the row
    → Return the row
  ELSE:
    → Return the existing row (do not recalculate)

This means no cron job is needed. Balance is created on first access per year.
Never update the entitlement row after creation — corrections go to balance_adjustments.
```

### Overtime target

```
overtime_target_hours = 0 in most cases (we do not grant overtime upfront)
It is a ceiling for overtime accrual if the organization sets one.
If the org does not use overtime targets, leave as 0 and ignore in balance calculation.
```

---

## Table 4: `organization_employee` — Contract Versioning

**Production has:** `employment_history` JSONB column (DEFAULT `[]`) on the employee row.

**What it needs:** A consistent structure inside that JSONB so contract history can be queried reliably.

### Required structure for each history entry

```json
[
  {
    "contract_id": "uuid",
    "employment_type": "full-time",
    "workload_percentage": 100,
    "weekly_target_hours": 40.0,
    "effective_from": "2024-01-01",
    "effective_to": "2025-05-31",
    "changed_reason": "Initial contract",
    "created_by": "admin_user_id",
    "created_at": "2024-01-01T00:00:00Z"
  },
  {
    "contract_id": "uuid",
    "employment_type": "part-time",
    "workload_percentage": 80,
    "weekly_target_hours": 32.0,
    "effective_from": "2025-06-01",
    "effective_to": null,
    "changed_reason": "Employee requested reduction",
    "created_by": "admin_user_id",
    "created_at": "2025-05-15T00:00:00Z"
  }
]
```

### How to query the contract active on a specific date

```
Find the entry in employment_history where:
  effective_from <= target_date
  AND (effective_to IS NULL OR effective_to >= target_date)

Always do this when submitting a time entry — use the contract from entry_date, not today.
The workload_percentage from this contract is what gets frozen into employee_workload_percent on the time_entry row.
```

### How to change a contract

```
Step 1: Find the currently active entry (effective_to = null) in the JSONB array
Step 2: Set its effective_to = change_date - 1 day
Step 3: Append a new entry with the new values and effective_from = change_date, effective_to = null
Step 4: Update the workload_percentage and employment_type on the top-level employee row to reflect current state
```

---

## Table 5: `organization_balance_adjustment`

**Production has:** Correct structure. `vacation_adjustment_hours`, `overtime_adjustment_hours`, `adjustment_type`, `reason`, `adjusted_by`.

**What it needs:** Discipline in how it is used.

### Adjustment types and when to use each

```
carryover          → Year-end rollover. Created at year transition.
                     vacation_adjustment_hours = unused vacation days from previous year × daily_hours
                     overtime_adjustment_hours = unused overtime hours from previous year
                     NOTE: we do NOT cap carryover — all unused hours carry forward

manual             → Admin correction. Requires reason + adjusted_by.

payout_vacation    → Vacation days paid out in cash (termination or org policy).
                     Negative vacation_adjustment_hours. Positive cash implication.

payout_overtime    → Overtime hours paid out in cash.
                     Negative overtime_adjustment_hours.

compensation_from_overtime → Employee takes a day off using overtime hours.
                     Negative overtime_adjustment_hours (reduce OT bank).
                     No vacation deduction (not a vacation day).
```

### Immutability rule

```
Never UPDATE an adjustment row.
If a mistake was made: INSERT a new row with the opposite sign and reason = "reversal of adj-id: X".
The full history of adjustments is always queryable.
```

---

## Table 6: `organization_holiday`

**Production has:** `organization_id`, `holiday_date`, `holiday_name`, `is_recurring`, soft-delete columns.

**What it needs:** One behavior fix.

### Recurring holidays

```
If is_recurring = true:
  Match any year. Query as: WHERE organization_id = ?
    AND EXTRACT(MONTH FROM holiday_date) = EXTRACT(MONTH FROM target_date)
    AND EXTRACT(DAY FROM holiday_date)   = EXTRACT(DAY FROM target_date)

If is_recurring = false:
  Match exact date only. Query as: WHERE organization_id = ? AND holiday_date = target_date

At time entry creation, check both recurring and non-recurring holidays.
The is_public_holiday flag on the time_entry is set then and frozen.
```

---

## How Everything Connects at Submit Time

This is the complete flow. Every step must happen in order within a single transaction.

```
SUBMIT time_entry (entry_id, submitted_by_user_id):

  BEGIN TRANSACTION

  1. Fetch time_entry WHERE id = entry_id AND entry_status = 'draft'
     → If not found or not draft: return error

  2. Fetch organization_timesheet_settings
     WHERE organization_id = entry.organization_id
       AND effective_from <= entry.entry_date
       AND (effective_to IS NULL OR effective_to > entry.entry_date)
     ORDER BY effective_from DESC LIMIT 1
     → This is the POLICY that governs this entry

  3. Fetch active contract from organization_employee.employment_history
     WHERE employee_id = entry.employee_id
       AND effective_from <= entry.entry_date
       AND (effective_to IS NULL OR effective_to >= entry.entry_date)
     → This gives workload_percentage for this entry

  4. Compute hours_worked
     = (entry.end_time - entry.start_time in hours) - (entry.break_minutes / 60)

  5. Compute effective overtime threshold
     = policy.overtime_threshold_hours × (contract.workload_percentage / 100)

  6. Compute weekly totals
     Sum hours_worked of all other entries this week (same org, same employee,
     entry_type = 'work', entry_status IN ('submitted', 'confirmed'),
     deletion_phase = 'active', week of entry.entry_date)
     → weekly_before = that sum
     → weekly_after  = weekly_before + hours_worked

  7. Compute regular / overtime / extratime splits
     regular_hours_worked = how much of hours_worked fits under overtime threshold
     overtime_hours       = hours between overtime threshold and extratime threshold
     extratime_hours      = hours above extratime threshold

  8. Compute premium hours
     sunday_premium_hours  = hours_worked if entry.is_sunday else 0
     holiday_premium_hours = hours_worked if entry.is_public_holiday else 0
     night_shift_hours     = overlap of (start_time, end_time) with night window

  9. Update the row:
     hours_worked                        = computed
     regular_hours_worked                = computed
     overtime_hours                      = computed
     extratime_hours                     = computed
     sunday_premium_hours                = computed
     holiday_premium_hours               = computed
     night_shift_hours                   = computed
     expected_daily_hours                = policy.default_daily_hours × (workload_percent/100)
     employee_workload_percent           = contract.workload_percentage  [FROZEN]
     weekly_overtime_threshold_snapshot  = policy.overtime_threshold_hours [FROZEN]
     weekly_extratime_threshold_snapshot = policy.extratime_threshold_hours [FROZEN]
     overtime_rate_percent_snapshot      = policy.overtime_rate_percent  [FROZEN]
     extratime_rate_percent_snapshot     = policy.extratime_rate_percent [FROZEN]
     sunday_premium_percent_snapshot     = policy.sunday_premium_percent [FROZEN]
     holiday_premium_percent_snapshot    = policy.holiday_premium_percent [FROZEN]
     night_premium_percent_snapshot      = policy.night_premium_percent  [FROZEN]
     calculation_context                 = full JSON audit (see below)
     entry_status                        = 'submitted'
     submitted_at                        = now()

  10. calculation_context JSON to store:
      {
        "policy_settings_id": "...",
        "policy_version": N,
        "policy_effective_from": "YYYY-MM-DD",
        "contract_workload_percent": N,
        "weekly_hours_before": N.N,
        "weekly_hours_after": N.N,
        "effective_overtime_threshold": N.N,
        "effective_extratime_threshold": N.N,
        "hours_breakdown": {
          "gross": N.N,
          "regular": N.N,
          "overtime": N.N,
          "extratime": N.N,
          "sunday_premium": N.N,
          "holiday_premium": N.N,
          "night_shift": N.N
        },
        "calculated_at": "ISO timestamp",
        "calculated_by": "system"
      }

  COMMIT

  If any step fails: ROLLBACK — entry stays in draft
```

---

## Balance Calculation — Live Read

When displaying current balance to employee or HR:

```
vacation_used_hours = SUM(absence_hours) FROM organization_time_entry
  WHERE employee_id = ?
    AND organization_id = ?
    AND EXTRACT(YEAR FROM entry_date) = year
    AND absence_type IN ('vacation', 'paid_leave')
    AND entry_status = 'confirmed'
    AND deletion_phase = 'active'

vacation_adjustments = SUM(vacation_adjustment_hours) FROM organization_balance_adjustment
  WHERE employee_id = ? AND organization_id = ? AND adjustment_year = year
    AND deletion_phase = 'active'

vacation_entitlement = vacation_entitlement_hours FROM organization_employee_annual_entitlement
  WHERE employee_id = ? AND organization_id = ? AND entitlement_year = year

vacation_balance = vacation_entitlement + vacation_adjustments - vacation_used_hours

Do same for overtime_balance using overtime columns.
```

---

## Rounding Rules — Critical

These caused real bugs in our test run. Follow them exactly.

```
Rule 1: Never round intermediate values. Only round the final result.
        WRONG:  round(23) × round(0.8)  = 23 × 1 = 23  (wrong!)
        CORRECT: round(23 × 0.8 × 10) / 10 = round(18.4) = 18.4

Rule 2: For hours/days display, round to 1 decimal place.
        Math.round(value × 10) / 10

Rule 3: For pro-rata: multiply full_days × (months_remaining / 12) first, then round.
        WRONG:  full_days × round(months_remaining / 12)
        CORRECT: round(full_days × (months_remaining / 12) × 10) / 10

Rule 4: For balance display, never show more than 2 decimal places.
        Use toFixed(2) for display. Store full precision in DB.
```

---

## What Production Already Has Correctly

These do not need to change — the schema is already right:

- `organization_id` on all tables → multi-tenancy safe
- `deletion_phase` ENUM on all tables → proper soft-delete
- `confirmed_by`, `confirmed_at` on time_entry → approval trail
- `rejected_by`, `rejected_by`, `rejection_reason` → rejection trail
- `calculation_context` JSONB on time_entry → audit ready
- All snapshot columns on time_entry → freezing is possible
- `vacation_rules` JSONB on timesheet_settings → flexible age brackets
- `calculated_from_age`, `calculated_from_workload` on entitlement → calculation audit

---

## What Production Is Missing (Must Add)

| Table | Add | Why |
|-------|-----|-----|
| `organization_timesheet_settings` | `version`, `effective_from`, `effective_to`, `change_reason`, `superseded_by` | Policy history for temporal integrity |
| `organization_employee.employment_history` | Enforce JSONB structure with `effective_from`, `effective_to` per entry | Contract versioning for historical accuracy |
| Any table | Nothing new structurally | Everything else is already present |

---

## Summary

Our test schema validated that temporal integrity works when:
1. Policy is never overwritten — new version inserted on change
2. Calculations are done once at submit — results frozen in row
3. Employee contract state is captured at submit — not read-time
4. Entitlement is calculated lazily — not by cron
5. Adjustments are immutable — reversals only, never updates
6. Rounding is applied only to final values — never intermediate

Production schema already has the columns. It needs the logic above applied consistently. The calculation flow in the "How Everything Connects" section is the exact logic proven by our 227 tests. Implement that and the timesheet module will be correct.
