# Schema Comparison: Production (SaasXPO) vs HRMS Test Schema

**Date**: 2026-04-06  
**Purpose**: Identify gaps between production database and our test HRMS schema; recommend best-of-both migration strategy.

---

## Executive Summary

**Production (SaasXPO) strengths:**
- Multi-tenancy via `organization_id` everywhere
- UUID + soft-delete pattern (`deleted_at/by/reason/deletion_phase`)
- Approval workflow for time entries (`submitted_at`, `confirmed_at/by`, `rejected_at/by`)
- Rich enum types for absence and entry classifications
- Boolean flags on time entries for fast queries (`is_sunday`, `is_public_holiday`, `is_night_shift`)

**Our test schema strengths:**
- **Versioned policies** (`company_policies` with `effective_from/effective_to/version`)
- **Explicit carryover tracking** on year balances (`vacation_carryover`, `overtime_carryover`)
- **Immutable time entry records** with frozen policy snapshots
- **Versioned employment contracts** (track historical changes)
- **Shared holiday calendar** (national/regional, not per-org only)

**Critical gap in production:**
- **No policy versioning** — `organization_timesheet_settings` is a single mutable row. If settings change, you can't query "what was the OT threshold on March 1?" without relying entirely on individual entry snapshots.
- **No carryover columns** — can't see year-start balances without recalculating from all prior entries.
- **No contract history** — employment changes are in `employment_history jsonb` + `previous_*` columns; not queryable.

---

## Detailed Table Comparison

### ORGANIZATION & EMPLOYEE CORE

#### `organization` (Production) vs nothing (Test)
**Production has:**
```
id, name, slug, logo, logo_url, logo_metadata,
created_at, created_by, updated_at,
metadata, contact_number, contact_email, registration_number,
active, organization_type, industry_type, industry_id, vat_type,
stakeholders (jsonb), billing_addons (array), has_multi_location
```
**Action:** We need to add multi-tenancy. Every test table must add `organization_id TEXT NOT NULL`.

---

#### `organization_employee` (Production) vs `employees` + contract logic (Test)

**Production columns (67 total):**
```
id, user_id, organization_id, role (enum), contract_type (enum),
active_status, created_at, created_by, updated_at,
employment_type, employment_start_date, employment_end_date,
workload_percentage, job_title, department, location_id,
date_of_birth, nationality, gender, marital_status,
address (jsonb), education, bank_details,
ahv_number, id_type, ahv_card_url, ahv_card_path,
id_card_url, id_card_path,
gross_wage, previous_salary, includes_13th_salary,
needs_contract, needs_registration, request_child_benefits,
number_of_children, children_details (jsonb),
withholding_tax_liable, withholding_tax_override,
bank_name, bank_account_number, bank_iban, bank_swift_code, bank_card_url,
has_children, spouse_id_type, children_birth_certificates_url,
vacation_pay_percentage, holiday_pay_percentage,
has_timesheet_access, admin_toggle_flag,
profile_completion_status, profile_completed_at, profile_completion_percentage,
previous_organization_id, previous_organization_name, organization_change_date, organization_change_reason,
employment_history (jsonb),
expo_push_token, previous_employment_type, previous_workload_percentage, previous_job_title,
previous_organization_change_date, previous_organization_change_reason,
deleted_at, deleted_by, deleted_at
```

**Our test schema:**
```
employees: id, name, role, date_of_birth, hire_date, location, status, created_at
employment_contracts: id, employee_id, employment_type, work_percentage, weekly_target_hours, 
                      effective_from, effective_to, created_at
```

**Recommendation — MERGE BOTH:**
```
organization_employee (matches production, add to our schema):
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id TEXT NOT NULL (FK → organization),
  user_id TEXT,
  name TEXT NOT NULL,  -- from our schema
  role employee_role NOT NULL,  -- use production enum
  contract_type contract_type NOT NULL,  -- permanent | temporary
  
  -- Employment (versioning moved to separate table, see below)
  employment_type TEXT NOT NULL,  -- full-time | part-time | intern
  employment_start_date DATE NOT NULL,  -- hire date
  employment_end_date DATE,  -- termination date
  workload_percentage INTEGER NOT NULL DEFAULT 100,
  
  -- Personal
  date_of_birth DATE NOT NULL,
  nationality TEXT,
  gender TEXT,
  address JSONB,
  
  -- Payroll
  gross_wage TEXT,
  vacation_pay_percentage TEXT,
  holiday_pay_percentage TEXT,
  
  -- Compliance
  ahv_number TEXT, id_type TEXT, withholding_tax_liable BOOLEAN,
  
  -- Audit
  created_at TIMESTAMP DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMP DEFAULT now(),
  updated_by TEXT,
  deleted_at TIMESTAMP,
  deleted_by TEXT,
  deleted_reason TEXT,
  deletion_phase deletion_phase DEFAULT 'active'
```

---

### EMPLOYMENT CONTRACTS

#### `employment_contracts` (Test) vs `employment_history` JSON (Production)

**Our test schema (relational, queryable):**
```
id, employee_id, employment_type, work_percentage, weekly_target_hours,
effective_from, effective_to, created_at
```

**Production (embedded):**
- `employment_history` → jsonb array (not queryable)
- `previous_employment_type`, `previous_workload_percentage` → individual columns (only 1 prior version)

**Recommendation — ADD TO PRODUCTION:**
```
organization_employment_contract (NEW):
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  employee_id TEXT NOT NULL (FK → organization_employee),
  organization_id TEXT NOT NULL,
  employment_type TEXT NOT NULL,  -- full-time | part-time | intern
  work_percentage INTEGER NOT NULL DEFAULT 100,
  weekly_target_hours NUMERIC NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,  -- NULL = currently active
  change_reason TEXT,
  
  created_at TIMESTAMP DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMP DEFAULT now(),
  updated_by TEXT,
  deleted_at TIMESTAMP,
  deleted_by TEXT,
  deletion_reason TEXT,
  deletion_phase deletion_phase DEFAULT 'active',
  
  UNIQUE(employee_id, effective_from)
```

This allows: `SELECT * FROM organization_employment_contract WHERE employee_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from DESC LIMIT 1` → get active contract on any date.

---

### POLICIES & SETTINGS

#### `organization_timesheet_settings` (Production) vs `company_policies` (Test)

**Production (CURRENT STATE):**
```
id, organization_id,
default_daily_hours, default_weekly_hours, max_weekly_hours,
overtime_threshold_hours, overtime_rate_percent,
extratime_threshold_hours, extratime_rate_percent,
sunday_premium_percent, holiday_premium_percent, night_premium_percent,
night_start_time, night_end_time,
use_age_based_vacation, default_vacation_days, vacation_rules (jsonb),
allow_partial_day_entries, vacation_accrual_method,
created_at, created_by, updated_at, updated_by,
deleted_at, deleted_by, deletion_reason, deletion_phase

⚠️ PROBLEM: Single mutable row per organization. No version history.
If you change overtime_rate_percent, the old value is lost forever.
```

**Our test schema:**
```
company_policies:
  id, version, 
  weekly_hours, max_weekly_hours, daily_hours,
  age_based_vacation, default_vacation_days, age_ranges (json),
  carryover_allowed, max_carryover_days,
  premium_rates (json: {overtime, extratime, holiday, sunday, night}),
  effective_from, effective_to,  -- versioning
  change_reason,
  created_at

✓ GOOD: Full version history. effective_to = NULL → currently active.
```

**Recommendation — REPLACE & RESTRUCTURE:**

```
organization_timesheet_settings (VERSIONED):
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id TEXT NOT NULL (FK → organization),
  
  -- Core thresholds
  default_daily_hours NUMERIC NOT NULL DEFAULT 8,
  default_weekly_hours NUMERIC NOT NULL DEFAULT 40,
  max_weekly_hours NUMERIC NOT NULL DEFAULT 48,
  
  -- Overtime & Extratime
  overtime_threshold_hours NUMERIC NOT NULL DEFAULT 40,
  overtime_rate_percent INTEGER NOT NULL DEFAULT 0,  -- 0 = tracked, no pay
  extratime_threshold_hours NUMERIC NOT NULL DEFAULT 48,
  extratime_rate_percent INTEGER NOT NULL DEFAULT 25,
  
  -- Premiums
  sunday_premium_percent INTEGER NOT NULL DEFAULT 100,
  holiday_premium_percent INTEGER NOT NULL DEFAULT 100,
  night_premium_percent INTEGER NOT NULL DEFAULT 25,
  night_start_time TIME NOT NULL DEFAULT '23:00',
  night_end_time TIME NOT NULL DEFAULT '06:00',
  
  -- Vacation rules
  use_age_based_vacation BOOLEAN NOT NULL DEFAULT true,
  default_vacation_days INTEGER NOT NULL DEFAULT 25,
  age_ranges JSONB,  -- [{minAge, maxAge, days}]
  max_carryover_days INTEGER NOT NULL DEFAULT 5,
  vacation_accrual_method TEXT DEFAULT 'annual',  -- annual | monthly
  allow_partial_day_entries BOOLEAN NOT NULL DEFAULT true,
  
  -- Versioning (NEW)
  version INTEGER NOT NULL DEFAULT 1,
  effective_from DATE NOT NULL,
  effective_to DATE,  -- NULL = currently active
  change_reason TEXT,
  
  -- Audit
  created_at TIMESTAMP DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMP DEFAULT now(),
  updated_by TEXT,
  deleted_at TIMESTAMP,
  deleted_by TEXT,
  deletion_reason TEXT,
  deletion_phase deletion_phase DEFAULT 'active',
  
  UNIQUE(organization_id, version, effective_from),
  CHECK(effective_to IS NULL OR effective_from < effective_to)
```

**Migration logic:**
```sql
-- Before adding version history:
INSERT INTO organization_timesheet_settings (version, organization_id, ...)
SELECT 1, id, [copy all current fields] FROM organization;

-- After adding a new policy version:
UPDATE organization_timesheet_settings 
SET effective_to = CURRENT_DATE - INTERVAL '1 day'
WHERE organization_id = ? AND effective_to IS NULL AND version < ?;

INSERT INTO organization_timesheet_settings (version, organization_id, ...)
VALUES (2, ?, CURRENT_DATE, ...);
```

---

### YEAR BALANCES & ENTITLEMENTS

#### `organization_employee_annual_entitlement` (Production) vs `year_balances` (Test)

**Production (INCOMPLETE):**
```
id, employee_id, organization_id, entitlement_year,
vacation_entitlement_hours,  -- ⚠️ IN HOURS, not days
overtime_target_hours,  -- This is a TARGET/THRESHOLD, not a carryover
calculated_from_age, calculated_from_workload,
calculated_at, calculated_by,
created_at, created_by, updated_at, updated_by,
deleted_at, deleted_by, deletion_reason, deletion_phase

⚠️ GAPS:
- No vacation_carryover_hours (what was brought in from prior year?)
- No overtime_carryover_hours (what OT carried from prior year?)
- No policy_id or snapshot (which policy generated these numbers?)
```

**Our test schema:**
```
year_balances:
  id, employee_id, year,
  vacation_entitlement, vacation_carryover,
  overtime_carryover,
  policy_id (FK),
  snapshot (json: how it was calculated),
  created_at

✓ Tracks carryovers
✓ Frozen calculation context
✗ Uses days for vacation, hours for OT (inconsistent with production)
```

**Recommendation — UPGRADE PRODUCTION TABLE:**

```
organization_employee_annual_entitlement (ENHANCED):
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  employee_id TEXT NOT NULL (FK → organization_employee),
  organization_id TEXT NOT NULL,
  entitlement_year INTEGER NOT NULL,
  
  -- Vacation (HOURS to match production)
  vacation_entitlement_hours NUMERIC NOT NULL DEFAULT 0,
  vacation_carryover_hours NUMERIC NOT NULL DEFAULT 0,  -- NEW: from prior year
  
  -- Overtime (HOURS)
  overtime_target_hours NUMERIC NOT NULL DEFAULT 0,  -- Renamed from threshold
  overtime_carryover_hours NUMERIC NOT NULL DEFAULT 0,  -- NEW: from prior year
  
  -- Audit trail
  calculated_from_age INTEGER,
  calculated_from_workload INTEGER,
  calculated_from_policy_version INTEGER,  -- NEW: which policy version
  calculated_at TIMESTAMP NOT NULL DEFAULT now(),
  calculated_by TEXT,
  
  calculation_context JSONB,  -- NEW: frozen calculation snapshot
  
  created_at TIMESTAMP DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMP DEFAULT now(),
  updated_by TEXT,
  deleted_at TIMESTAMP,
  deleted_by TEXT,
  deletion_reason TEXT,
  deletion_phase deletion_phase DEFAULT 'active',
  
  UNIQUE(employee_id, entitlement_year),
  CHECK(vacation_entitlement_hours >= 0 AND vacation_carryover_hours >= 0)
```

**Unit clarification:**
- **Vacation**: Always **HOURS** (8h = 1 day). In reports, divide by 8 to show days.
- **Overtime**: Always **HOURS**.

---

### TIME ENTRIES

#### `organization_time_entry` (Production) vs `time_entries` (Test)

**Production (COMPREHENSIVE):**
```
id, employee_id, organization_id, entry_date,
entry_type (enum: work | absence), entry_status (enum: draft | active | pending | confirmed | rejected),
start_time, end_time, break_minutes,
hours_worked, regular_hours_worked, overtime_hours, extratime_hours,
night_shift_hours, sunday_premium_hours, holiday_premium_hours,
is_sunday, is_public_holiday, is_night_shift (boolean flags),
absence_type (enum: 20 types), absence_hours, is_paid_absence, counts_as_worked,
notes, attachment_url,
submitted_at, confirmed_at, confirmed_by, rejected_at, rejected_by, rejection_reason,
expected_daily_hours, employee_workload_percent,
weekly_overtime_threshold_snapshot, weekly_extratime_threshold_snapshot,
sunday_premium_percent_snapshot, holiday_premium_percent_snapshot, night_premium_percent_snapshot,
overtime_rate_percent_snapshot, extratime_rate_percent_snapshot,
calculation_context (jsonb),
created_at, created_by, updated_at, updated_by,
deleted_at, deleted_by, deletion_reason, deletion_phase

✓ Excellent structure!
✓ Individual snapshot columns per rate type (easier to query than single blob)
✓ Boolean flags for performance
✓ Approval workflow
```

**Our test schema:**
```
time_entries:
  id, employee_id, work_date, entry_type,
  clock_in, clock_out, break_minutes,
  hours, regular_hours, overtime_hours, extratime_hours,
  holiday_premium, sunday_premium, night_premium,
  policy_id, snapshot (text json),
  source, status,
  created_at, approved_by, approved_at

✗ Single snapshot blob (harder to query)
✗ No approval workflow
✗ No is_sunday/is_public_holiday flags
✗ Missing absence_type enum detail
```

**Recommendation — ADOPT PRODUCTION STRUCTURE:**

Keep production's `organization_time_entry` exactly as-is. Our schema validation proves the concept; production has the proper implementation.

---

### BALANCE ADJUSTMENTS

#### `organization_balance_adjustment` (Production) vs `balance_adjustments` (Test)

**Production:**
```
id, employee_id, organization_id, adjustment_year,
adjustment_type (enum: carryover | payout | manual_correction | annual_entitlement),
vacation_adjustment_hours, overtime_adjustment_hours,
reason, notes,
adjusted_at, adjusted_by,
created_at, created_by, updated_at, updated_by,
deleted_at, deleted_by, deletion_reason, deletion_phase
```

**Our test schema:**
```
balance_adjustments:
  id, employee_id, year,
  adjustment_type,
  amount (can be positive or negative),
  unit (days | hours),
  reason, created_by, created_at
```

**Recommendation — ADOPT PRODUCTION:**

Production structure is better: two separate columns (`vacation_adjustment_hours`, `overtime_adjustment_hours`) avoid confusion about units. Switch to production style.

---

### HOLIDAYS

#### `organization_holiday` (Production) vs `public_holidays` (Test)

**Production:**
```
id, organization_id, holiday_date, holiday_name, is_recurring, description,
created_at, created_by, updated_at, updated_by,
deleted_at, deleted_by, deletion_reason, deletion_phase

⚠️ PROBLEM: Per-organization only. No national/regional shared calendar.
Every organization must enter Swiss New Year, Christmas, etc. manually.
```

**Our test schema:**
```
public_holidays:
  id, date, name, type (public | company | floating),
  recurring, region (CH), created_at

✓ Can be shared
✓ Regional variants possible
```

**Recommendation — TWO TABLES:**

```
-- National/regional shared calendar
public_holiday (NEW):
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  holiday_date DATE NOT NULL,
  holiday_name TEXT NOT NULL,
  region TEXT DEFAULT 'CH',  -- Switzerland default
  is_recurring BOOLEAN DEFAULT true,
  description TEXT,
  
  created_at TIMESTAMP DEFAULT now(),
  created_by TEXT,
  deleted_at TIMESTAMP,
  deletion_phase deletion_phase DEFAULT 'active',
  
  UNIQUE(holiday_date, region)

-- Organization overrides/custom holidays
organization_holiday (use production structure):
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id TEXT NOT NULL,
  holiday_date DATE NOT NULL,
  holiday_name TEXT NOT NULL,
  is_recurring BOOLEAN,
  description TEXT,
  
  created_at TIMESTAMP DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMP DEFAULT now(),
  updated_by TEXT,
  deleted_at TIMESTAMP,
  deleted_by TEXT,
  deletion_reason TEXT,
  deletion_phase deletion_phase DEFAULT 'active',
  
  UNIQUE(organization_id, holiday_date)
```

---

## Summary: Changes Needed

### Enum Types to Add (if not already in prod)
```
-- If not present, create:
CREATE TYPE timesheet_entry_type AS ENUM ('work', 'absence');
CREATE TYPE timesheet_entry_status AS ENUM ('draft', 'active', 'pending', 'confirmed', 'rejected');
CREATE TYPE timesheet_absence_type AS ENUM (
  'vacation', 'sick_paid', 'sick_unpaid', 'maternity', 'paternity', 'parental',
  'bereavement', 'military', 'public_holiday', 'compensatory_time_off', 'unpaid_leave',
  'sabbatical', 'training', 'conference', 'business_trip', 'jury_duty', 'medical_appointment',
  'family_care', 'moving_day', 'other'
);
CREATE TYPE timesheet_adjustment_type AS ENUM ('carryover', 'payout', 'manual_correction', 'annual_entitlement');
CREATE TYPE deletion_phase AS ENUM ('active', 'soft', 'archive', 'hard');
```

### New Tables to Create
1. **`organization_employment_contract`** — versioned contracts
2. **`public_holiday`** — shared national/regional calendar
3. **`organization_timesheet_settings_history`** (or extend existing) — versioned policy

### Existing Tables to Extend
1. **`organization_timesheet_settings`** — add `version`, `effective_from`, `effective_to`, `change_reason`
2. **`organization_employee_annual_entitlement`** — add `vacation_carryover_hours`, `overtime_carryover_hours`, `calculated_from_policy_version`, `calculation_context`

### No Changes Needed
- `organization_time_entry` — production already has the right structure
- `organization_balance_adjustment` — production structure is better than ours
- `organization_employee` — just add multi-tenancy to our test schema

---

## Naming Convention (Production Standard)

| Element | Convention | Example |
|---------|-----------|---------|
| Table | `organization_[entity]` | `organization_employee`, `organization_time_entry` |
| Shared table | `[entity]` | `public_holiday`, `organization` |
| Primary key | `id` (UUID text) | `id TEXT DEFAULT gen_random_uuid()::text` |
| Foreign key | `[entity]_id` | `employee_id`, `organization_id` |
| Boolean flag | `is_[property]` or `has_[property]` | `is_sunday`, `has_timesheet_access` |
| Status fields | `[entity]_status` or `[entity]_phase` | `entry_status`, `deletion_phase` |
| Timestamp | `[action]_at` | `submitted_at`, `confirmed_at`, `created_at` |
| User tracking | `[action]_by` | `submitted_by`, `confirmed_by`, `created_by` |
| Soft delete | `deleted_at`, `deleted_by`, `deletion_reason`, `deletion_phase` | All tables |
| JSON fields | snake_case column names | `calculation_context`, `age_ranges`, `vacation_rules` |

---

## Recommended Implementation Order

**Phase 1 (Core versioning):**
1. Add `version`, `effective_from`, `effective_to`, `change_reason` to `organization_timesheet_settings`
2. Create `organization_employment_contract` table
3. Add `calculated_from_policy_version`, `calculation_context` to `organization_employee_annual_entitlement`

**Phase 2 (Carryovers):**
4. Add `vacation_carryover_hours`, `overtime_carryover_hours` to `organization_employee_annual_entitlement`
5. Create migration to backfill carryover calculations

**Phase 3 (Holiday calendar):**
6. Create `public_holiday` table
7. Populate with Swiss 2024–2026 holidays
8. Create reference from `organization_holiday` to shared holidays (optional)

**Phase 4 (Data migration):**
8. Run test suite against production schema
9. Validate all historical calculations remain accurate
10. Deploy to staging, then production

---

## Validation Checklist

- [ ] Can query "what policy was active on any given date?"
- [ ] Can calculate "what was the OT rate on March 1, 2025?"
- [ ] Can see year-start balances (entitlement + carryover) without recalculation
- [ ] Can trace any time entry calculation to the frozen snapshot + policy version
- [ ] Can audit who changed a policy and when
- [ ] No orphaned time entries (all reference valid policy versions)
- [ ] Carryover calculations produce same results as test suite
- [ ] Contract changes are queryable via `effective_from/effective_to`

---

## Conclusion

**Best of both approach:**
- ✅ Keep production's multi-tenancy, soft-delete, UUID, approval workflow, rich enums
- ✅ Add our test schema's versioned policies and carryover tracking
- ✅ Adopt production's time_entry structure (individual snapshot columns beat single JSON blob)
- ✅ Extend annual_entitlement with carryover columns and calculation context
- ✅ Create shared holiday calendar + org-specific overrides

This gives you the **temporal data integrity** you need (frozen calculations, queryable policy history) while maintaining production's **operational maturity** (approvals, soft deletes, auditability).
