# SaasXPO Production Schema vs Test Schema Comparison

**Generated:** 2026-04-07  
**Purpose:** Map test schema learnings to production SaasXPO database structure

---

## Executive Summary

| Aspect | SaasXPO Production | Our Test Schema | Gap/Recommendation |
|--------|------------------|-----------------|------------------|
| **Platform** | PostgreSQL (17.6) | SQLite 3 | SQL syntax differences, UDTs, JSON types |
| **Multi-tenancy** | organization_id on all tables | Single org (dummy data) | ADD organization_id filtering everywhere |
| **Policy Versioning** | Stored in timesheet_settings (single) | company_policies with versions | Extend timesheet_settings to support versioning |
| **Calculations** | Snapshots stored in time_entry rows | Snapshots stored separately | Keep current approach, add snapshot columns to time_entry |
| **Employee History** | Flat employee table + employment_history JSONB | employment_contracts separate table | Use employment_history JSONB or create versioned approach |
| **Premium Calculation** | Snapshot columns + calculation_context JSONB | policy_id FK with JOIN | Add snapshot columns to match production |
| **Balance Tracking** | organization_employee_annual_entitlement | year_balances + balance_adjustments | Rename to match production naming |
| **Soft Deletes** | deleted_at, deleted_by, deletion_phase ENUM | deleted_at, deleted_by, deleted_reason TEXT | Add deletion_phase type enum |

---

## Detailed Table Mapping

### 1. EMPLOYEE MANAGEMENT

#### Production: `organization_employee` (280 rows)
```
Core Employee Data:
- id, user_id, organization_id, location_id (partition keys)
- active_status: 'active'|'inactive' (text, DEFAULT 'active')
- employment_start_date, employment_end_date (date)
- employment_type (text)
- workload_percentage (integer, 0-100)

Extensibility Fields:
- address (JSONB)
- employment_history (JSONB, DEFAULT '[]')
- children_details (JSONB)
- job_title, department, role (text)
- has_timesheet_access (boolean, DEFAULT true)

Soft Delete Pattern:
- deleted_at, deleted_by, deletion_reason (text)
- deletion_phase (ENUM: 'active'|'archived'|'soft_deleted')

Audit Fields:
- created_at, created_by, updated_at, updated_by
```

#### Our Test Schema: `employees` (6 rows)
```
- id (INTEGER PRIMARY KEY)
- name, email (TEXT)
- date_of_birth (DATE) - for age-based vacation
- employment_start_date (DATE)
- employment_end_date (DATE)
- workload_percentage (INTEGER, 0-100)
- active (BOOLEAN)
```

#### Mapping Recommendations:
```sql
-- Align with production (PostgreSQL migration)
CREATE TABLE IF NOT EXISTS organization_employee_v2 (
  -- Production PK
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id TEXT NOT NULL,  -- ADD: multi-tenancy
  user_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  
  -- From test schema (keep)
  date_of_birth DATE,
  employment_start_date DATE NOT NULL,
  employment_end_date DATE,
  workload_percentage INTEGER DEFAULT 100,
  
  -- From production
  active_status TEXT DEFAULT 'active',
  employment_type TEXT,
  job_title TEXT,
  department TEXT,
  has_timesheet_access BOOLEAN DEFAULT true,
  
  -- History (JSONB instead of separate table)
  employment_history JSONB DEFAULT '[]'::jsonb,
  
  -- Soft delete
  deleted_at TIMESTAMP WITH TIME ZONE,
  deleted_by TEXT,
  deletion_reason TEXT,
  deletion_phase deletion_phase DEFAULT 'active',
  
  -- Audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_by TEXT
);
```

**Action Items:**
- [ ] Keep employment_history as JSONB instead of separate employment_contracts table
- [ ] Add organization_id to all queries (filter by org)
- [ ] Use deletion_phase enum for soft deletes
- [ ] Store address, children_details as JSONB if needed in future

---

### 2. TIME TRACKING & CALCULATION STORAGE

#### Production: `organization_time_entry` (9 rows)
```
Entry Metadata:
- id (UUID text)
- employee_id, organization_id (TEXT, FK)
- entry_date (DATE)
- entry_type (ENUM: 'work'|'absence'|'adjustment')
- entry_status (ENUM: 'draft'|'submitted'|'confirmed'|'rejected')

Time Data:
- start_time, end_time (TIME)
- break_minutes (INT, DEFAULT 0)
- hours_worked (NUMERIC)

Absence Data:
- absence_type (ENUM)
- absence_hours (NUMERIC)
- is_paid_absence (BOOLEAN)
- counts_as_worked (BOOLEAN)

Calculated Fields (DENORMALIZED):
- regular_hours_worked (NUMERIC)
- overtime_hours (NUMERIC)
- extratime_hours (NUMERIC)
- night_shift_hours (NUMERIC)
- sunday_premium_hours (NUMERIC)
- holiday_premium_hours (NUMERIC)

Premium Snapshots (FROZEN POLICY STATE):
- weekly_overtime_threshold_snapshot (NUMERIC) - policy value at submit time
- weekly_extratime_threshold_snapshot (NUMERIC)
- sunday_premium_percent_snapshot (INTEGER)
- holiday_premium_percent_snapshot (INTEGER)
- night_premium_percent_snapshot (INTEGER)
- overtime_rate_percent_snapshot (INTEGER)
- extratime_rate_percent_snapshot (INTEGER)

Context Snapshots (COMPLETE AUDIT):
- expected_daily_hours (NUMERIC) - employee's expected hours that day
- employee_workload_percent (INTEGER) - employee's % at time of entry
- calculation_context (JSONB) - full calculation details
- weekly_overtime_threshold_snapshot (NUMERIC)

Approvals & Audit:
- submitted_at, confirmed_at, confirmed_by
- rejected_at, rejected_by, rejection_reason
- created_at, created_by, updated_at, updated_by
- deleted_at, deleted_by, deletion_reason, deletion_phase

Special Flags:
- is_sunday, is_public_holiday, is_night_shift (BOOLEAN)
- notes, attachment_url (TEXT)
```

#### Our Test Schema: `time_entries` (21 rows)
```
- id (INTEGER PRIMARY KEY)
- employee_id, policy_id (FK)
- entry_date (DATE)
- gross_hours (DECIMAL)
- policy_version_id (FK)
- regular_hours, overtime_hours, premium_hours (DECIMAL)
- created_at, calculated_at, calculated_by
```

#### Key Insight - CRITICAL DIFFERENCE:
**Production DENORMALIZES calculations + snapshots into time_entry row**  
**Our test uses NORMALIZED approach: policy_id FK + JOIN**

Production approach (easier for clients):
```sql
-- All data in one row, no JOIN needed
SELECT hours_worked, overtime_hours, sunday_premium_hours, 
       sunday_premium_percent_snapshot, calculation_context
FROM organization_time_entry
WHERE employee_id = ? AND entry_date = ?
```

Our approach (cleaner, more normalized):
```sql
-- Must JOIN to get policy rules
SELECT te.hours_worked, te.overtime_hours, cp.sunday_premium_percent
FROM time_entries te
JOIN company_policies cp ON te.policy_id = cp.id
WHERE te.employee_id = ? AND te.entry_date = ?
```

#### Mapping Recommendations:
```sql
-- Update our time_entries to match production denormalization
ALTER TABLE time_entries ADD COLUMN (
  -- Calculated denormalized fields (frozen at submit time)
  regular_hours_worked NUMERIC,
  overtime_hours NUMERIC,
  extratime_hours NUMERIC,
  night_shift_hours NUMERIC,
  sunday_premium_hours NUMERIC,
  holiday_premium_hours NUMERIC,
  
  -- Premium snapshots (policy state at submit time)
  weekly_overtime_threshold_snapshot NUMERIC,
  weekly_extratime_threshold_snapshot NUMERIC,
  sunday_premium_percent_snapshot INTEGER,
  holiday_premium_percent_snapshot INTEGER,
  night_premium_percent_snapshot INTEGER,
  overtime_rate_percent_snapshot INTEGER,
  extratime_rate_percent_snapshot INTEGER,
  
  -- Context
  expected_daily_hours NUMERIC,
  employee_workload_percent INTEGER,
  calculation_context JSONB,
  
  -- Entry metadata
  entry_type TEXT DEFAULT 'work', -- 'work'|'absence'|'adjustment'
  entry_status TEXT DEFAULT 'draft', -- 'draft'|'submitted'|'confirmed'|'rejected'
  absence_type TEXT,
  absence_hours NUMERIC,
  is_paid_absence BOOLEAN DEFAULT false,
  counts_as_worked BOOLEAN DEFAULT false,
  is_sunday BOOLEAN DEFAULT false,
  is_public_holiday BOOLEAN DEFAULT false,
  is_night_shift BOOLEAN DEFAULT false,
  
  -- Submission/Approval workflow
  submitted_at TIMESTAMP,
  confirmed_at TIMESTAMP,
  confirmed_by TEXT,
  rejected_at TIMESTAMP,
  rejected_by TEXT,
  rejection_reason TEXT
);
```

**Action Items:**
- [ ] Add all snapshot columns to store frozen policy state
- [ ] Add calculation_context JSONB for full audit trail
- [ ] Add entry_type enum for work/absence/adjustment
- [ ] Add entry_status enum for workflow tracking
- [ ] Keep policy_id FK for historical reference
- [ ] Populate snapshots when time_entry is submitted (not on creation)

---

### 3. POLICY & ENTITLEMENT SETTINGS

#### Production: `organization_timesheet_settings` (3 rows)
```
Core Settings:
- id, organization_id (TEXT, PK + FK)
- default_daily_hours (NUMERIC, DEFAULT 8.00)
- default_weekly_hours (NUMERIC, DEFAULT 40.00)
- max_weekly_hours (NUMERIC, DEFAULT 48.00)

Overtime/Extratime:
- overtime_threshold_hours (NUMERIC, DEFAULT 40.00)
- overtime_rate_percent (INTEGER, DEFAULT 0)
- extratime_threshold_hours (NUMERIC, DEFAULT 48.00)
- extratime_rate_percent (INTEGER, DEFAULT 25)

Premiums:
- sunday_premium_percent (INTEGER, DEFAULT 100)
- holiday_premium_percent (INTEGER, DEFAULT 100)
- night_premium_percent (INTEGER, DEFAULT 25)
- night_start_time (TIME, DEFAULT '23:00')
- night_end_time (TIME, DEFAULT '06:00')

Vacation/Leave:
- use_age_based_vacation (BOOLEAN, DEFAULT true)
- default_vacation_days (INTEGER, DEFAULT 20)
- vacation_rules (JSONB, DEFAULT age bracket rules)
- vacation_accrual_method (TEXT, DEFAULT 'proportional')
- allow_partial_day_entries (BOOLEAN, DEFAULT true)

Audit & Soft Delete:
- created_at, created_by, updated_at, updated_by
- deleted_at, deleted_by, deletion_reason, deletion_phase
```

#### Our Test Schema: `company_policies` (1 main row)
```
- id (INTEGER PRIMARY KEY)
- version (INTEGER)
- effective_from, effective_to (DATE)
- daily_hours, weekly_hours, max_weekly_hours (DECIMAL)
- overtime_threshold, overtime_rate (DECIMAL/INTEGER)
- vacation_days (INTEGER)
- age_brackets (JSON object)
- created_at, created_by
```

#### Key Insight - CRITICAL DIFFERENCE:
**Production has NO versioning in timesheet_settings**  
**Settings are single row per organization**  
**Our test has full versioning with effective dates**

Production approach (simpler for current use):
```sql
-- One settings row per org, update in place
UPDATE organization_timesheet_settings
SET overtime_threshold_hours = 35
WHERE organization_id = ?
-- Old values are LOST
```

Our approach (historical accuracy):
```sql
-- Create new version on each change
INSERT INTO company_policies (
  version, effective_from, effective_to, overtime_threshold
) VALUES (2, '2025-07-01', NULL, 35)
-- Old version remains available for historical queries
```

#### Mapping Recommendations:
```sql
-- Option A: Extend production table for versioning
CREATE TABLE organization_timesheet_settings_history (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  
  -- Copy all settings fields here
  default_daily_hours NUMERIC DEFAULT 8,
  overtime_threshold_hours NUMERIC DEFAULT 40,
  overtime_rate_percent INTEGER DEFAULT 0,
  sunday_premium_percent INTEGER DEFAULT 100,
  vacation_rules JSONB,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_by TEXT,
  
  UNIQUE(organization_id, effective_from)
);

-- Current settings point to latest active version
CREATE OR REPLACE VIEW organization_timesheet_settings_current AS
SELECT * FROM organization_timesheet_settings_history
WHERE organization_id = ? 
  AND effective_from <= CURRENT_DATE
  AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
ORDER BY effective_from DESC
LIMIT 1;

-- Option B: Keep single settings table, add versioning columns
ALTER TABLE organization_timesheet_settings ADD COLUMN (
  version INTEGER DEFAULT 1,
  effective_from DATE DEFAULT CURRENT_DATE,
  effective_to DATE, -- NULL = current
  previous_version_id TEXT -- FK to historical version
);
```

**Action Items:**
- [ ] Add versioning to timesheet_settings (effective_from/effective_to/version)
- [ ] Keep previous values in history (or separate history table)
- [ ] Update snapshots on time_entry when policy changes
- [ ] When submitting time_entry, capture which version is active
- [ ] Support querying "which policy was active on date X"

---

### 4. ENTITLEMENT & BALANCE TRACKING

#### Production: `organization_employee_annual_entitlement` (6 rows)
```
- id (UUID text)
- employee_id, organization_id (TEXT, FK)
- entitlement_year (INTEGER) - year of entitlement
- vacation_entitlement_hours (NUMERIC, DEFAULT 0)
- overtime_target_hours (NUMERIC, DEFAULT 0)
- calculated_from_age (INTEGER) - employee's age at calculation time
- calculated_from_workload (INTEGER) - employee's % at calculation time
- calculated_at (TIMESTAMP)
- calculated_by (TEXT)

Audit:
- created_at, created_by, updated_at, updated_by
- deleted_at, deleted_by, deletion_reason, deletion_phase
```

#### Production: `organization_balance_adjustment` (0 rows currently)
```
- id (UUID text)
- employee_id, organization_id (TEXT, FK)
- adjustment_year (INTEGER)
- adjustment_type (ENUM: 'carryover'|'manual'|'correction'|'advance')
- vacation_adjustment_hours (NUMERIC, DEFAULT 0)
- overtime_adjustment_hours (NUMERIC, DEFAULT 0)
- reason (TEXT)
- notes (TEXT)
- adjusted_at (TIMESTAMP)
- adjusted_by (TEXT, WHO made adjustment)

Audit:
- created_at, created_by, updated_at, updated_by
- deleted_at, deleted_by, deletion_reason, deletion_phase
```

#### Our Test Schema: `year_balances` + `balance_adjustments`
```
year_balances:
- id, employee_id, entitlement_year
- vacation_entitlement, overtime_target
- calculated_at, calculated_by

balance_adjustments:
- id, employee_id, year
- adjustment_type, hours
- reason, created_at, created_by
```

#### Mapping Recommendations:
```sql
-- Rename to match production naming
RENAME TABLE year_balances TO organization_employee_annual_entitlement;
RENAME TABLE balance_adjustments TO organization_balance_adjustment;

-- Add missing columns
ALTER TABLE organization_employee_annual_entitlement ADD COLUMN (
  organization_id TEXT NOT NULL,
  calculated_from_age INTEGER,
  calculated_from_workload INTEGER
);

ALTER TABLE organization_balance_adjustment ADD COLUMN (
  organization_id TEXT NOT NULL,
  adjustment_year INTEGER NOT NULL,
  adjusted_at TIMESTAMP NOT NULL DEFAULT now(),
  adjusted_by TEXT NOT NULL
);
```

**Action Items:**
- [ ] Rename tables to match production naming convention
- [ ] Add organization_id to both tables
- [ ] Track calculated_from_age and calculated_from_workload for historical accuracy
- [ ] Add adjusted_by to track who made manual adjustments
- [ ] Implement lazy initialization: create balance on first access of year

---

### 5. HOLIDAYS & CALENDAR

#### Production: `organization_holiday` (1 row)
```
- id (UUID text)
- organization_id (TEXT)
- holiday_date (DATE)
- holiday_name (TEXT)
- is_recurring (BOOLEAN, DEFAULT false)
- description (TEXT)

Audit:
- created_at, created_by, updated_at, updated_by
- deleted_at, deleted_by, deletion_reason, deletion_phase
```

#### Our Test Schema: `public_holidays`
```
- id, date, name, country (TEXT)
- created_at (TIMESTAMP)
```

#### Mapping Recommendations:
```sql
-- Align with production
ALTER TABLE public_holidays ADD COLUMN (
  organization_id TEXT NOT NULL,
  is_recurring BOOLEAN DEFAULT false,
  description TEXT,
  created_by TEXT,
  updated_at TIMESTAMP DEFAULT now(),
  updated_by TEXT,
  deleted_at TIMESTAMP,
  deleted_by TEXT,
  deletion_reason TEXT,
  deletion_phase TEXT DEFAULT 'active'
);

-- Remove country column (use organization_id for regional variation)
-- Different orgs can have different holiday calendars
```

**Action Items:**
- [ ] Add organization_id (different orgs have different holiday calendars)
- [ ] Add is_recurring for holidays that repeat yearly
- [ ] Add full audit trail (created_by, updated_by, deleted_by)

---

## Data Flow Comparison

### Creating a Time Entry with Calculations

**Production SaasXPO:**
```
1. POST /api/time-entry
   → Create organization_time_entry row (entry_status='draft')
   → Store only user input (start_time, end_time, break_minutes)

2. PUT /api/time-entry/:id/submit
   → Fetch employee's workload_percentage (at submission time)
   → Fetch current organization_timesheet_settings (policy)
   → CALCULATE overtime, premiums
   → Store calculated fields in same row:
      - regular_hours_worked
      - overtime_hours
      - sunday_premium_hours
   → Store snapshots:
      - weekly_overtime_threshold_snapshot (from settings)
      - sunday_premium_percent_snapshot (from settings)
      - employee_workload_percent (from employee table)
      - calculation_context (full calculation JSON)
   → Set entry_status='submitted'
   → Update updated_at

3. PUT /api/time-entry/:id/confirm (manager approval)
   → Set entry_status='confirmed'
   → Set confirmed_at, confirmed_by
```

**Our Test Schema:**
```
1. INSERT into time_entries
   → Store entry_date, employee_id, gross_hours
   → Store policy_id (FK to company_policies)
   → Calculate immediately:
      - regular_hours
      - overtime_hours
      - premium_hours
   → Store in same row

2. No separate submission workflow (simplified)
   → Assume entries are final on insert
```

---

## Critical Remapping Strategy

### Phase 1: Align Table Structures ✅ (This document)
- [x] Understand production schema structure
- [x] Map our test tables to production tables
- [x] Identify denormalization vs normalization differences
- [ ] Create migration scripts for each table

### Phase 2: Data Model Adjustments (Next Steps)
- [ ] Add organization_id to all queries (multi-tenancy)
- [ ] Extend time_entries with snapshot columns
- [ ] Add versioning to timesheet_settings
- [ ] Update balance tracking naming and fields
- [ ] Implement soft-delete enums (deletion_phase)

### Phase 3: Business Logic Migration
- [ ] Adapt vacation calculation to use vacation_rules JSONB
- [ ] Implement aged-based vs tenure-based vacation rules
- [ ] Add entry_status workflow (draft→submitted→confirmed→rejected)
- [ ] Update overtime calculation to use snapshot values
- [ ] Implement partial day leave handling

### Phase 4: Query Pattern Updates
- [ ] Replace FK JOINs with snapshot columns
- [ ] Update approval workflow queries
- [ ] Add organization filtering to all queries
- [ ] Support historical policy queries by effective date

---

## Field Mapping Quick Reference

| Test Schema | Production Schema | Notes |
|-------------|------------------|-------|
| `employees.id` | `organization_employee.id` | UUID text, add user_id, location_id |
| `employees.employment_start_date` | Same | DATE field, keep |
| `employees.workload_percentage` | `workload_percentage` | INTEGER 0-100 |
| `company_policies.id` | `organization_timesheet_settings.id` | Add versioning |
| `company_policies.overtime_threshold` | `overtime_threshold_hours` | NUMERIC |
| `time_entries.gross_hours` | `hours_worked` | NUMERIC |
| `time_entries.policy_id` | (snapshot columns) | Denormalize snapshots into row |
| `time_entries.regular_hours` | `regular_hours_worked` | NUMERIC, denormalized |
| `time_entries.overtime_hours` | `overtime_hours` | NUMERIC, denormalized |
| `year_balances` | `organization_employee_annual_entitlement` | Rename table |
| `balance_adjustments` | `organization_balance_adjustment` | Rename table |
| `public_holidays` | `organization_holiday` | Add organization_id |

---

## Implementation Priority

**MUST HAVE (for temporal integrity):**
1. ✅ Store snapshots of policy at time of entry submission
2. ✅ Track calculation context (how was it calculated)
3. ✅ Versioning for policy changes (effective_from/effective_to)
4. ✅ Never update old entries (create new versions)
5. ✅ Soft deletes with audit trail

**SHOULD HAVE (for production readiness):**
1. ✅ Multi-tenancy (organization_id everywhere)
2. ✅ Entry workflow (draft→submitted→confirmed→rejected)
3. ✅ Calculated fields denormalized (no JOIN needed for reports)
4. ✅ Absence types and paid/unpaid distinction
5. ✅ Night shift handling

**NICE TO HAVE (future enhancements):**
- Leave request approval workflow
- Shift templates and scheduling
- Payroll integration
- Real-time balance notifications

---

## Summary

**SaasXPO Production uses:**
- ✅ Denormalized snapshots in time_entry (easier for clients)
- ✅ Single timesheet_settings per org (needs versioning for historical accuracy)
- ✅ JSONB employment_history instead of separate contract table
- ✅ Full soft-delete pattern with deletion_phase enum
- ✅ Multi-tenancy with organization_id on all tables

**Our Test Schema does well:**
- ✅ Policy versioning with effective dates
- ✅ Normalized approach with FK joins
- ✅ Immutable time entries (no updates)
- ✅ Comprehensive audit fields

**Bridge the gap:**
1. Add denormalized snapshot columns to time_entries
2. Add versioning to timesheet_settings
3. Add organization_id to all queries
4. Rename tables to production naming convention
5. Extend soft-delete pattern with deletion_phase enum
