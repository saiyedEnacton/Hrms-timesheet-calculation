# Schema Remapping Action Plan
## Test Schema → SaasXPO Production

**Date:** 2026-04-07  
**Prepared for:** Team Lead Review

---

## Current State (Test Schema - SQLite)
```
✅ 7 Tables (employees, employment_contracts, company_policies, 
    public_holidays, time_entries, year_balances, balance_adjustments)
✅ Policy versioning (effective_from/effective_to)
✅ Immutable entries (no updates, only inserts)
✅ 227 comprehensive tests (195 passed, 85.9%)
✅ Temporal data integrity validated
```

## Target State (SaasXPO Production - PostgreSQL)
```
✅ 7+ Production Tables with denormalization
✅ Multi-tenancy (organization_id)
✅ Snapshot columns for frozen calculations
✅ Soft-delete pattern (deletion_phase enum)
✅ Entry workflow (draft→submitted→confirmed→rejected)
```

---

## 5-Step Remapping Plan

### Step 1: TABLE RENAMING & ORGANIZATION_ID
**Tables to update:** ALL  
**Effort:** Low (1 hour)

```
1. year_balances                          
   → organization_employee_annual_entitlement
   ADD COLUMN: organization_id (TEXT NOT NULL)
   ADD COLUMNS: calculated_from_age, calculated_from_workload

2. balance_adjustments                    
   → organization_balance_adjustment
   ADD COLUMN: organization_id (TEXT NOT NULL)
   ADD COLUMN: adjusted_by (TEXT NOT NULL)
   RENAME: adjustment_type → adjustment_type (keep ENUM)

3. public_holidays                        
   → organization_holiday
   ADD COLUMN: organization_id (TEXT NOT NULL)
   ADD COLUMN: is_recurring (BOOLEAN DEFAULT false)
   ADD COLUMNS: created_by, updated_by, deleted_by
   REMOVE: country (use organization filtering instead)

4. employees                              
   → organization_employee
   ADD COLUMN: organization_id (TEXT NOT NULL)
   ADD COLUMN: location_id (TEXT NOT NULL)
   ADD COLUMN: user_id (TEXT NOT NULL)
   ADD COLUMN: active_status (TEXT DEFAULT 'active')
   RENAME: active → active_status
   ADD COLUMN: employment_history (JSONB DEFAULT '[]'::jsonb)
   DROP TABLE: employment_contracts (merge into employment_history JSONB)
```

**Impact:** 
- All queries must add `WHERE organization_id = ?` filter
- Multi-tenant safety: can't accidentally see other org's data
- 4 tables affected, ~2 hours total migration

---

### Step 2: DENORMALIZE TIME_ENTRIES SNAPSHOTS
**Table:** time_entries → organization_time_entry  
**Effort:** Medium (3 hours)

**Current approach (Normalized):**
```sql
SELECT te.gross_hours, cp.daily_hours
FROM time_entries te
JOIN company_policies cp ON te.policy_id = cp.id
WHERE te.employee_id = ?
```

**Target approach (Denormalized):**
```sql
SELECT hours_worked, regular_hours_worked, overtime_hours,
       sunday_premium_hours, sunday_premium_percent_snapshot
FROM organization_time_entry
WHERE employee_id = ? AND entry_date = ?
-- No JOIN needed! All data in one row
```

**Add columns to time_entries:**
```sql
-- Calculated fields (denormalized for performance)
ALTER TABLE time_entries ADD COLUMN (
  regular_hours_worked NUMERIC,
  overtime_hours NUMERIC,
  extratime_hours NUMERIC,
  night_shift_hours NUMERIC,
  sunday_premium_hours NUMERIC,
  holiday_premium_hours NUMERIC,
  
  -- Premium snapshots (frozen at submission time)
  weekly_overtime_threshold_snapshot NUMERIC,
  weekly_extratime_threshold_snapshot NUMERIC,
  sunday_premium_percent_snapshot INTEGER,
  holiday_premium_percent_snapshot INTEGER,
  night_premium_percent_snapshot INTEGER,
  overtime_rate_percent_snapshot INTEGER,
  extratime_rate_percent_snapshot INTEGER,
  
  -- Context snapshot (full audit trail)
  expected_daily_hours NUMERIC,
  employee_workload_percent INTEGER,
  calculation_context JSONB
);
```

**Populate snapshots:**
```javascript
// When time_entry is submitted, capture policy state
const policy = await db.query(
  'SELECT * FROM company_policies WHERE id = ? AND effective_to IS NULL',
  [policyId]
);

INSERT INTO time_entries (
  ...,
  overtime_hours,
  sunday_premium_percent_snapshot,
  calculation_context
) VALUES (
  ...,
  calculatedOvertime,
  policy.sunday_premium_percent,  // FREEZE this value
  JSON.stringify({
    policy_version: policy.version,
    employee_workload: employee.workload_percentage,
    calculation_date: new Date(),
    rules_applied: { ... }
  })
);
```

**Impact:**
- Queries no longer need policy JOIN
- Reports show exactly what was calculated at submit time
- Historical accuracy: even if policy changes, old entry shows original rates
- ~100 LOC changes across all test files

---

### Step 3: ADD ENTRY WORKFLOW STATUS
**Table:** time_entries → organization_time_entry  
**Effort:** Low (2 hours)

**Add columns:**
```sql
ALTER TABLE time_entries ADD COLUMN (
  -- Entry metadata
  entry_type TEXT DEFAULT 'work', -- 'work'|'absence'|'adjustment'
  entry_status TEXT DEFAULT 'draft', -- 'draft'|'submitted'|'confirmed'|'rejected'
  
  -- Absence details
  absence_type TEXT,
  absence_hours NUMERIC,
  is_paid_absence BOOLEAN DEFAULT false,
  counts_as_worked BOOLEAN DEFAULT false,
  
  -- Special dates
  is_sunday BOOLEAN DEFAULT false,
  is_public_holiday BOOLEAN DEFAULT false,
  is_night_shift BOOLEAN DEFAULT false,
  
  -- Submission workflow
  submitted_at TIMESTAMP,
  confirmed_at TIMESTAMP,
  confirmed_by TEXT,
  rejected_at TIMESTAMP,
  rejected_by TEXT,
  rejection_reason TEXT
);
```

**New workflow:**
```
1. POST /api/time-entry (create in draft status)
   entry_status = 'draft'

2. PUT /api/time-entry/:id/submit (calculate & submit)
   → Calculate snapshots
   → Set entry_status = 'submitted'
   → Set submitted_at = now()

3. PUT /api/time-entry/:id/confirm (manager approves)
   → Set entry_status = 'confirmed'
   → Set confirmed_at = now()
   → Set confirmed_by = manager_id

4. PUT /api/time-entry/:id/reject (optional)
   → Set entry_status = 'rejected'
   → Set rejected_at = now()
   → Set rejected_by = manager_id
   → Set rejection_reason = "..."
```

**Impact:**
- Enforces approval workflow
- Separates draft changes from submitted/locked entries
- Enables manager review before confirmation
- ~50 LOC API changes

---

### Step 4: POLICY VERSIONING
**Table:** company_policies  
**Effort:** Medium (2 hours)

**Current state:** One policy with versions  
**Production state:** Single timesheet_settings per org (no history)

**Option A: Keep test schema versioning (RECOMMENDED)**
```sql
-- Keep company_policies with versioning
ALTER TABLE company_policies ADD COLUMN (
  organization_id TEXT NOT NULL
);

-- When policy changes:
INSERT INTO company_policies (
  organization_id,
  version,
  effective_from,
  effective_to,
  overtime_threshold,
  ...
) VALUES (...);

-- Query: "What policy was active on date X?"
SELECT * FROM company_policies
WHERE organization_id = ?
  AND effective_from <= ?
  AND (effective_to IS NULL OR effective_to > ?)
LIMIT 1;
```

**Option B: Extend production settings approach**
```sql
-- Create versioned settings history
CREATE TABLE organization_timesheet_settings_history (
  id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL,
  version INTEGER,
  effective_from DATE,
  effective_to DATE,
  overtime_threshold_hours NUMERIC,
  ...
);

-- Keep single row in organization_timesheet_settings
-- Add FK to current active version
ALTER TABLE organization_timesheet_settings ADD COLUMN (
  current_version_id UUID FK
);
```

**Recommendation:** Use Option A (test schema approach)  
**Why:** Simpler, proven to work, supports historical queries

**Impact:**
- No changes to test code
- Production can migrate to versioned settings incrementally
- Each time_entry snapshot shows which version was active

---

### Step 5: SOFT DELETE PATTERN
**Tables:** ALL  
**Effort:** Low (1 hour)

**Current test schema:**
```sql
deleted_at TIMESTAMP
deleted_by TEXT
deleted_reason TEXT
```

**Add production pattern:**
```sql
ALTER TABLE [all_tables] ADD COLUMN (
  deletion_phase TEXT DEFAULT 'active'
    CHECK (deletion_phase IN ('active', 'archived', 'soft_deleted'))
);

-- Create enum (PostgreSQL only)
CREATE TYPE deletion_phase AS ENUM ('active', 'archived', 'soft_deleted');
ALTER TABLE [all_tables] 
  ALTER COLUMN deletion_phase TYPE deletion_phase USING deletion_phase::deletion_phase;
```

**Soft delete pattern:**
```javascript
// Mark as deleted (never actually delete)
db.prepare(`
  UPDATE time_entries 
  SET deleted_at = now(),
      deleted_by = ?,
      deletion_reason = ?,
      deletion_phase = 'soft_deleted'
  WHERE id = ?
`).run(userId, reason, entryId);

// Query only active entries
db.query(`
  SELECT * FROM time_entries
  WHERE employee_id = ? 
    AND (deleted_at IS NULL OR deletion_phase = 'active')
`);
```

**Impact:**
- Audit trail preserved (who deleted, when, why)
- Can restore deleted entries if needed
- Compliance: data never actually lost
- ~10 LOC per table

---

## Implementation Checklist

### Week 1: Foundation
- [ ] Create migration scripts for all table renames
- [ ] Add organization_id to all tables
- [ ] Update all test queries to filter by organization_id
- [ ] Run existing tests to ensure nothing breaks

### Week 2: Snapshots & Calculations
- [ ] Add snapshot columns to time_entries
- [ ] Update calculation logic to populate snapshots at submit time
- [ ] Update all test files to verify snapshot values
- [ ] Update test assertions (no more policy_id joins)

### Week 3: Workflow & Enums
- [ ] Add entry_type, entry_status, absence_type columns
- [ ] Implement submission workflow (draft→submitted→confirmed)
- [ ] Add deletion_phase enum to all tables
- [ ] Update soft-delete queries

### Week 4: Testing & Docs
- [ ] Re-run all 227 tests with new schema
- [ ] Update SEED_DATA_SNAPSHOTS.md with new field mappings
- [ ] Create migration documentation for production deployment
- [ ] Generate SQL migration scripts for each step

---

## SQL Migration Script Template

```sql
-- Migration: 001_add_organization_multi_tenancy.sql
-- Date: 2026-04-07
-- Description: Add organization_id to all HRMS tables

BEGIN TRANSACTION;

-- 1. Rename tables
ALTER TABLE year_balances 
  RENAME TO organization_employee_annual_entitlement;

ALTER TABLE balance_adjustments 
  RENAME TO organization_balance_adjustment;

ALTER TABLE public_holidays 
  RENAME TO organization_holiday;

-- 2. Add organization_id
ALTER TABLE organization_employee_annual_entitlement 
  ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'default_org';

ALTER TABLE organization_balance_adjustment 
  ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'default_org';

ALTER TABLE organization_holiday 
  ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'default_org';

ALTER TABLE employees
  ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'default_org';

-- 3. Create indexes for performance
CREATE INDEX idx_org_employee_annual_org_emp 
  ON organization_employee_annual_entitlement(organization_id, employee_id);

CREATE INDEX idx_org_balance_adj_org_emp 
  ON organization_balance_adjustment(organization_id, employee_id);

CREATE INDEX idx_org_holiday_org_date 
  ON organization_holiday(organization_id, holiday_date);

COMMIT;
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Breaking existing queries | HIGH | MEDIUM | All queries get org_id filter, test thoroughly |
| Data loss during migration | LOW | CRITICAL | Backup before migration, dry run on test DB |
| Performance degradation | LOW | MEDIUM | Add indexes, test with real data volume |
| Snapshot calculation errors | MEDIUM | HIGH | Unit test each calculation, compare results |
| Workflow state inconsistency | LOW | HIGH | Add validation constraints, test transitions |

---

## Success Criteria

✅ All 227 tests pass with new schema  
✅ No queries without organization_id filter (multi-tenancy safe)  
✅ Snapshots correctly frozen at submit time  
✅ Historical policy queries work (what was active on date X)  
✅ Soft deletes preserve audit trail  
✅ Calculations identical to original (regressions: 0)  
✅ No performance degradation on read queries  

---

## Timeline Estimate

| Phase | Duration | Effort |
|-------|----------|--------|
| 1. Renaming + org_id | 2-3 days | 4-6 hours |
| 2. Snapshots | 3-4 days | 6-8 hours |
| 3. Workflow status | 2-3 days | 3-4 hours |
| 4. Versioning | 1-2 days | 2-3 hours |
| 5. Soft deletes | 1 day | 1-2 hours |
| Testing & Docs | 3-4 days | 6-8 hours |
| **TOTAL** | **~2 weeks** | **~25 hours** |

---

## Next Steps

1. **Review this plan** with team lead
2. **Prioritize phases** (recommend: 1→2→3→4→5)
3. **Create feature branch** for remapping work
4. **Run Week 1 migrations** in test environment
5. **Re-run all tests** and verify regressions = 0
6. **Document changes** for production deployment

---

## API Layer Notes for Developer

> These are not actual routes — just notes on what each area of the API needs to handle and what the developer must be careful about. Use these as a checklist when building or reviewing the API.

---

### TIME ENTRY — Create / Draft

**What it does:** Employee logs a new entry (clock in/out, break, date)

**What to check:**
- Always create in `draft` status — never submit immediately
- Validate `entry_date` is not in the future
- Validate employee belongs to the same `organization_id` as the request — never allow cross-org writes
- Check if a non-soft-deleted entry already exists for the same `employee_id + work_date + entry_type` — prevent accidental duplicates
- Check if `work_date` falls on a public holiday (`organization_holiday`) — set `is_public_holiday = true` automatically
- Check if `work_date` is a Sunday — set `is_sunday = true` automatically
- If `entry_type = absence`, require `absence_type` and `absence_hours`
- Do NOT calculate overtime or premiums yet — that happens on submit

---

### TIME ENTRY — Submit (Calculations happen here)

**What it does:** Employee finalizes the entry — all calculation snapshots are frozen at this moment

**What to check:**
- Must be in `draft` status before submission — reject if already `submitted` or `confirmed`
- Fetch the **active policy version** as of `work_date` (not today) — use `effective_from <= work_date AND (effective_to IS NULL OR effective_to > work_date)`
- Fetch employee's `workload_percentage` — from the contract that was active on `work_date`, not the current contract
- Calculate gross hours: `(clock_out - clock_in) - break_minutes`
- Determine `regular_hours`, `overtime_hours`, `extratime_hours` — all based on weekly accumulation, not just this day alone
  - Weekly overtime check: sum all submitted hours in same ISO week for that employee, then decide how many hours in this entry push past the threshold
  - This means the order of submission within a week matters — document this behavior
- Calculate `sunday_premium_hours`, `holiday_premium_hours`, `night_shift_hours` — based on flags set at creation
- Freeze all policy values into snapshot columns: `weekly_overtime_threshold_snapshot`, `sunday_premium_percent_snapshot`, etc.
- Freeze employee state: `employee_workload_percent`, `expected_daily_hours`
- Populate `calculation_context` JSONB with full breakdown: what rules were applied, what policy version, what workload
- Set `submitted_at = now()`, `entry_status = submitted`
- Do NOT allow editing after submission — any correction must be a new adjustment entry

---

### TIME ENTRY — Approve / Confirm

**What it does:** Manager confirms the submitted entry is correct

**What to check:**
- Must be in `submitted` status — reject if draft or already confirmed
- Confirming manager must be from the same organization — check `organization_id`
- Store `confirmed_by` (manager user_id) and `confirmed_at`
- Once confirmed, entry is immutable — no edits, no recalculation
- If time entry is for vacation/absence, check if employee has sufficient balance before confirming (or flag for admin review)
- Trigger balance deduction only after confirmation — not at submit time

---

### TIME ENTRY — Reject

**What it does:** Manager sends the entry back — employee must correct and resubmit

**What to check:**
- Can only reject `submitted` entries
- Must provide a `rejection_reason` — do not allow empty reason
- Set `entry_status = rejected`, store `rejected_by`, `rejected_at`
- Employee should be able to edit and resubmit — set back to `draft` after rejection, not delete
- Any calculation snapshots from the rejected submission should be cleared on resubmit

---

### TIME ENTRY — List / View (Current Period)

**What it does:** Employee or manager views entries for a week/month

**What to check:**
- Always filter by `organization_id` first
- Only return entries where `deletion_phase = active` (exclude soft-deleted)
- Support filter by `entry_status` — employee sees all, manager sees `submitted` + `confirmed`
- Paginate by week or month — avoid returning entire history in one call
- For weekly summary, aggregate: total `hours_worked`, `overtime_hours`, `regular_hours`, `vacation_hours` from entries in that week
- Return snapshot values alongside — client should display the frozen values, not recalculate

---

### TIME ENTRY — Historical / Audit View

**What it does:** Admin or compliance officer looks at past entries — must be exactly as they were

**What to check:**
- Never recalculate — return stored snapshot values only
- Return `calculation_context` JSONB so reviewer can see exactly how calculation was done at that time
- Filter by `organization_id + employee_id + date range`
- Show which policy version was active (from snapshot or via `policy_id` FK join on history table)
- Show `confirmed_by`, `confirmed_at` for audit trail
- If entry was soft-deleted, admin should still be able to see it with `deletion_phase = soft_deleted` filter
- Support export (for payroll or compliance) — include all snapshot columns in export

---

### POLICY — Get Active Policy

**What it does:** Any calculation or display that needs current rules

**What to check:**
- Always query by `organization_id` AND `effective_from <= target_date AND (effective_to IS NULL OR effective_to > target_date)`
- Never use `ORDER BY id DESC LIMIT 1` as a shortcut — use date range filter, that is the contract
- If no policy found for a date, return error — do not silently fall back to any policy
- Cache carefully: policy can change mid-year, so a request on Jan 1 vs Aug 1 may return different versions

---

### POLICY — Update / Change Rules

**What it does:** Admin changes overtime threshold, premium rates, vacation rules

**What to check:**
- Never `UPDATE` the existing policy row in place — that destroys history
- Close the current version: set `effective_to = change_date - 1 day`
- Insert a new row with new values and `effective_from = change_date`, `effective_to = NULL`
- All time entries submitted after `change_date` will pick up the new policy
- All time entries submitted before `change_date` keep their frozen snapshot values — they are unaffected
- Validate that `effective_from` of new version does not overlap with any existing version for the same org
- Store `change_reason` and `created_by` on the new version row

---

### EMPLOYEE ANNUAL ENTITLEMENT — Get or Initialize

**What it does:** Retrieve how many vacation/overtime hours an employee is entitled to for a given year

**What to check:**
- Use lazy initialization: if no row exists for `employee_id + year`, calculate and insert now (do not require a cron job)
- Calculation depends on: age as of Jan 1 of that year, workload_percentage of active contract on Jan 1, active policy's vacation rules on Jan 1
- Store `calculated_from_age` and `calculated_from_workload` — these are audit fields showing what values were used
- For employees hired mid-year, apply pro-rata: `full_entitlement × (remaining_months / 12)` — round only the final result, not intermediate values
- If employee's contract changes mid-year (workload change), the entitlement for that year may need a correction entry in `balance_adjustments` — do not update the original row

---

### BALANCE — Get Current Balance

**What it does:** Show employee how many vacation days / overtime hours they have left

**What to check:**
- Balance = entitlement + carryover + manual adjustments − used entries (confirmed vacation/sick/etc.)
- Do not compute this on the fly from raw entries every time — cache or store a running balance
- Query `organization_employee_annual_entitlement` for the base
- Add all `organization_balance_adjustment` rows for that employee + year
- Subtract all confirmed `organization_time_entry` rows where `entry_type = absence` and `counts_as_worked = false` for that year
- Negative balance is possible (advance leave) — handle gracefully, flag for admin
- Separate vacation balance from overtime balance — they are different units (days vs hours)

---

### BALANCE ADJUSTMENT — Manual Correction

**What it does:** Admin adds/removes days or hours from an employee's balance (payout, correction, carryover)

**What to check:**
- Always require `reason` and `adjusted_by` — never allow anonymous adjustments
- Store `adjustment_type`: `manual`, `carryover`, `payout_vacation`, `payout_overtime`, `compensation_from_overtime`
- Positive amount = credit (adding days/hours), negative = debit (removing)
- Adjustments are immutable once inserted — if wrong, insert a reversal row with opposite amount
- Log who made the adjustment (`adjusted_by`) and when (`adjusted_at`)
- Year-end carryover is itself an adjustment row of type `carryover` inserted at year boundary — not automatic, triggered manually or by process

---

### TIMESHEET — Weekly Summary

**What it does:** Shows employee a week's worth of entries and totals

**What to check:**
- Define week boundaries clearly (Mon–Sun or Sun–Sat) — must be consistent across all calcs
- Weekly overtime threshold check: sum all `hours_worked` from confirmed/submitted entries in the week, compare against `overtime_threshold_hours` from active policy
- Show both gross hours and breakdown: regular, overtime, extratime, premiums
- Highlight days with special flags: `is_sunday`, `is_public_holiday`, `is_night_shift`
- Show remaining balance (vacation days left, overtime balance) at the bottom
- If any entry is still in `draft`, flag it clearly — weekly total may not be final

---

### TIMESHEET — Monthly / Historical Summary

**What it does:** Payroll export, HR review, compliance check for a past month

**What to check:**
- Pull from stored snapshot values — do not recalculate
- Group by week within month for overtime boundary (a week that spans two months should be attributed correctly)
- Show policy version that was active during each week — include version number in export
- Include all absence types separately: vacation, sick, accident, public holiday, compensation day
- Include premium totals: total sunday hours × rate, total holiday hours × rate, total night hours × rate
- Show which entries were confirmed vs still submitted — payroll should only process confirmed entries
- Include `confirmed_by` name for each confirmed entry in export

---

### HOLIDAY CALENDAR — Check if Date is Holiday

**What it does:** Called during time entry creation and calculation to flag special dates

**What to check:**
- Always filter by `organization_id` — different orgs may have different holiday calendars
- Handle recurring holidays: a holiday marked `is_recurring = true` matches any year, not just the stored year
- Return holiday name alongside the boolean — useful for display
- Cache this lookup per org per year to avoid hitting DB on every entry creation
- Cross-check with `is_sunday` separately — a Sunday that is also a public holiday may qualify for stacked premiums (check policy for stacking rules)

---

### SOFT DELETE — Any Table

**What it does:** Remove an entry without actually deleting data

**What to check:**
- Never use `DELETE FROM` on any HRMS table — always soft delete
- Set `deleted_at`, `deleted_by`, `deletion_reason`, `deletion_phase = soft_deleted`
- All list queries must filter `WHERE deletion_phase = 'active'` by default
- Admin views should have an optional `include_deleted` flag to show soft-deleted records
- If re-activating a soft-deleted entry (e.g. accidental delete), set `deletion_phase = active` and clear `deleted_at` — log this action
- Confirmed time entries should not be soft-deletable without manager override and a mandatory reason
