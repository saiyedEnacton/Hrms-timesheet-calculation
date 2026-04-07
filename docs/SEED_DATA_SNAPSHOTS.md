# SEED DATA SNAPSHOTS — Before & After Each Test Group

This document shows the database state (seed data) before and after each test group runs. Use this to understand data flow and validate test outcomes.

---

## Initial Seed State (After `node seed.js`)

All test groups start from this baseline.

### Employees (6 total)

| ID | Name | DOB | Hire Date | Role | Status |
|----|------|-----|-----------|------|--------|
| mm | Max Müller | 1997-03-15 | 2024-12-01 | Service | active |
| as | Anna Schmidt | 1990-07-22 | 2025-01-01 | Küche | active |
| pk | Peter Keller | 1973-11-08 | 2025-03-01 | Bar | active |
| sl | Sarah Lang | 2001-05-14 | 2025-07-01 | Service | active |
| tw | Thomas Weber | 1980-02-28 | 2025-09-01 | Küche | active |
| lm | Lisa Meier | 2006-09-03 | 2025-12-01 | Service | active |

### Employment Contracts (Active)

| Employee | Type | Work % | Weekly Target | Effective From |
|----------|------|--------|---|---|
| mm | full-time | 100 | 40h | 2024-12-01 |
| as | part-time | 80 | 32h | 2025-01-01 |
| pk | full-time | 100 | 40h | 2025-03-01 |
| sl | full-time | 100 | 40h | 2025-07-01 |
| tw | part-time | 60 | 24h | 2025-09-01 |
| lm | intern | 100 | 40h | 2025-12-01 |

### Company Policies (v1 Active)

| Version | Weekly Hours | Max Weekly | Daily | Age-Based | Default Days | Carryover Cap |
|---------|--------------|------------|-------|-----------|--------------|---------------|
| 1 | 40 | 48 | 8 | true | 25 | 5 |

**Age Brackets**:
- 18-19: 29 days
- 20-49: 23 days
- 50+: 29 days

**Premium Rates**:
- Overtime: 0% (tracked only)
- Extratime (>48h): 25%
- Holiday: 100%
- Sunday: 100%
- Night (23:00-06:00): 25%

### Public Holidays (10 - Swiss 2025)

```
2025-01-01  Neujahr
2025-01-02  Berchtoldstag
2025-04-18  Karfreitag
2025-04-21  Ostermontag
2025-05-01  Tag der Arbeit
2025-05-29  Auffahrt
2025-06-09  Pfingstmontag
2025-08-01  Bundesfeier
2025-12-25  Weihnachten
2025-12-26  Stephanstag
```

### Year Balances (2025)

| Employee | Entitlement | Carryover | OT Carryover |
|----------|-------------|-----------|--------------|
| mm | 23 | 3 | 8 |
| as | 18.4 | 0 | 0 |
| pk | 29 | 0 | 0 |
| sl | 23 | 0 | 0 |
| tw | 0 | 0 | 0 |
| lm | 23 | 0 | 0 |

**Note**: pk hired 2025-03-01 (pro-rata: 10 months = 24.17 days calculated)

### Time Entries (Sample)

**Max Müller** (10 work + 2 vacation):
```
2025-03-03 to 2025-03-07: 8.5h/day (42.5h week = 2.5h OT)
2025-03-10 to 2025-03-14: 8.5h/day (42.5h week = 2.5h OT)
2025-03-17: vacation (8h)
2025-03-18: vacation (8h)
```

**Anna Schmidt** (8 work + 1 sick):
```
2025-03-03 to 2025-03-06: 8h/day (32h week = 0h OT at 80%)
2025-03-10 to 2025-03-13: 8h/day (32h week = 0h OT at 80%)
2025-03-07: sick (8h)
```

---

## Test Group 4: Premium Calculations

### Before
- 1 policy (v1)
- 2 employees with time entries (Max, Anna)
- No premium entries yet

### Changes Made
1. **Add regular weekday entry** (2025-03-05, Max, 8h) → No premiums
2. **Add Sunday entry** (2025-03-16, Max, 8.5h) → Sunday premium 8.5h
3. **Add holiday entry** (2025-05-01 Tag der Arbeit, Max, 8.5h) → Holiday premium 8.5h
4. **Add night shift entry** (2025-03-10 23:00-06:00 next day, Max, 9h) → Night premium 7h
5. **Add stacked entry** (2025-04-06 Sunday+Holiday 23:00-06:00, Max, 9h) → All three premiums
6. **Add holiday+overtime** (2025-08-01 Bundesfeier, Max, 9.5h) → OT 1.5h + Holiday 9.5h
7. **Add extratime** (5 days × 10h = 50h week, Max) → Extratime 2h (>48h)
8. **Policy rate change test** → Create v2 & v3 policies, verify old entries stay v1

### After
- 4 policies (v1, v2, v3, v2 reopened)
- Multiple premium entries documented
- Policy change integrity verified

**Key Data State**:
```sql
SELECT te.work_date, te.hours, te.regular_hours, te.overtime_hours,
       te.sunday_premium, te.holiday_premium, te.night_premium
FROM time_entries te
WHERE te.employee_id = 'mm'
ORDER BY te.work_date;

-- Results show:
-- 2025-03-05: 8.0 regular, 0 premium (weekday)
-- 2025-03-16: 8.5 sunday, 0.5 overtime
-- 2025-05-01: 8.5 holiday premium
-- etc.
```

---

## Test Group 2: Policy Change Mid-Year

### Before
- Policy v1 (40h threshold) active on 2025-01-01
- Max has March entries at v1 rules
- No v2 policy yet

### Changes Made
1. **Create policy v2** (effective 2025-07-01, 35h threshold, flat 28 days vacation)
2. **Close v1** (set effective_to = 2025-06-30)
3. **Add March entry** (Max, 2025-03-10, 8.5h) → Uses v1 (40h threshold)
4. **Add August entry** (Max, 2025-08-04, 7.5h) → Uses v2 (35h threshold)
5. **Lazy init 2026 balance** → Picks up v2 rules

### After
- Policy v1: effective_to = 2025-06-30 (closed)
- Policy v2: effective_from = 2025-07-01, effective_to = NULL (active)
- March entry: policy_id = 1 (frozen at v1)
- August entry: policy_id = 2 (uses v2)
- 2026 balance created: vacation_entitlement = 28 (v2 flat rule, not age-based)

**Key Data State**:
```sql
-- Old entries still frozen
SELECT work_date, policy_id FROM time_entries
WHERE employee_id = 'mm' AND work_date >= '2025-03-01';

-- 2025-03-10: policy_id = 1 (v1)
-- 2025-08-04: policy_id = 2 (v2)

-- 2026 balance uses v2
SELECT vacation_entitlement FROM year_balances
WHERE employee_id = 'mm' AND year = 2026;
-- Result: 28 (flat rule from v2, not age-based)
```

---

## Test Group 3: Contract Change Mid-Year

### Before
- Anna has 80% contract (32h/week) from 2025-01-01
- Only March entries exist (80% threshold)
- No contract change yet

### Changes Made
1. **Add March entry** (Anna, 2025-03-03, 8h at 80%) → No OT (32h/week threshold)
2. **Close 80% contract** (effective_to = 2025-05-31)
3. **Create 60% contract** (effective_from = 2025-06-01, 24h/week)
4. **Add June entry** (Anna, 2025-06-02, 8h at 60%) → 3.2h OT (24h/week threshold)
5. **Lazy init 2026 balance** → 60% entitlement (13.8 days)

### After
- Anna March entries: policy_id = 1, overtime_hours = 0 (32h target)
- Anna June entries: policy_id = 1, overtime_hours = 3.2 (24h target, same 8h gross)
- Contract (80%): effective_to = 2025-05-31
- Contract (60%): effective_from = 2025-06-01, effective_to = NULL
- 2026 balance: vacation_entitlement = 13.8 (23 days × 60%)

**Key Data State**:
```sql
-- Same 8h worked, different OT due to contract %
SELECT work_date, hours, regular_hours, overtime_hours
FROM time_entries
WHERE employee_id = 'as'
  AND work_date IN ('2025-03-03', '2025-06-02');

-- 2025-03-03: 8h gross, 8h regular, 0h OT (6.4h threshold)
-- 2025-06-02: 8h gross, 4.8h regular, 3.2h OT (4.8h threshold)
```

---

## Test Group 5: Vacation Tracking

### Before
- Max: 24 vacation days available (23 entitlement + 3 carryover − 2 used in seed)
- No additional vacation entries

### Changes Made
1. **Log 2 vacation days** (Max, 2025-04-07 & 2025-04-08) → Balance: 22 days
2. **Log vacation week** (Max, 5 days skipping public holiday) → Balance: 17 days
3. **Test advance leave** (Sarah, −30 days deduction) → Balance: −7 days (negative)
4. **Reverse advance** (+30 days) → Balance: 23 days again
5. **Log payouts** (Max, 10 days → balance adjustment) → Balance: 12 days
6. **Log manual corrections** (reason tracked)

### After
- Max balance: Varies per test (shows accumulation/deduction)
- Multiple vacation entries in time_entries
- Multiple adjustments in balance_adjustments (with reasons)
- Negative balance possible (advance leave scenario)

**Key Data State**:
```sql
-- Vacation used
SELECT COALESCE(SUM(hours) / 8.0, 0) as days
FROM time_entries
WHERE employee_id = 'mm' AND entry_type = 'vacation';
-- Result shows cumulative days used

-- Remaining = Entitlement + Carryover − Used + Adjustments
SELECT 
  vacation_entitlement + vacation_carryover as balance,
  (SELECT COALESCE(SUM(hours) / 8.0, 0) FROM time_entries 
   WHERE employee_id = 'mm' AND entry_type = 'vacation') as used,
  (SELECT COALESCE(SUM(amount), 0) FROM balance_adjustments 
   WHERE employee_id = 'mm') as adjustments
FROM year_balances
WHERE employee_id = 'mm' AND year = 2025;
```

---

## Test Group 6: Overtime & Compensation

### Before
- Max: 8h OT carryover from 2024
- No additional OT entries
- No compensation entries

### Changes Made
1. **Add 5 work days** (8.5h/day = 42.5h week) → 2.5h OT per week × 2 weeks = 5h new OT
2. **Total OT** = 8 carryover + 5 earned = 13h
3. **Log compensation days** (2 days × 8h = 16h) → Balance: −3h (deficit)
4. **OT payout** (10h) → Balance: −13h

### After
- Max OT earned: 5h (from 2 weeks of 42.5h/week)
- Max OT balance: Calculated from entitlement + carryover − used
- Compensation entries: Type = 'compensation', hours = 8
- Payout recorded: Type = 'compensation', balance_adjustment with reason

**Key Data State**:
```sql
-- OT balance = Carryover + Earned − Used
SELECT 
  (SELECT overtime_carryover FROM year_balances 
   WHERE employee_id = 'mm' AND year = 2025) as carryover,
  (SELECT COALESCE(SUM(overtime_hours), 0) FROM time_entries 
   WHERE employee_id = 'mm' AND strftime('%Y', work_date) = '2025') as earned,
  (SELECT COALESCE(SUM(amount), 0) FROM balance_adjustments 
   WHERE employee_id = 'mm' AND year = 2025' AND unit = 'hours') as adjustments;
```

---

## Test Group 7: Year-End Rollover

### Before
- 2025 has activity (time entries, balance_adjustments)
- No 2026 balance yet

### Changes Made
1. **Add vacation entries for 2025** (5 days × 8h = 40h)
2. **Add OT entries for 2025** (5 days × 1h OT)
3. **Call ensureYearBalance(mm, 2026)** → Lazy init
4. **Calculate carryover**:
   - Vacation unused = 23 + 3 − 40 = −14 (capped at 0)
   - OT carryover = 8 + 5 = 13

### After
- 2025 balance: Unchanged (23 + 3 entitlement, 5 + 8 OT)
- 2026 balance (lazy-created):
  - Entitlement: 23 days (age 27, still 20-49 bracket)
  - Carryover: 0 (unused was negative, capped to 0)
  - OT carryover: 13h
  - Created on first access, not by cron

**Key Data State**:
```sql
-- 2025: Original balance
SELECT * FROM year_balances WHERE employee_id = 'mm' AND year = 2025;
-- vacation_entitlement: 23, vacation_carryover: 3, overtime_carryover: 8

-- 2026: Lazy-initialized
SELECT * FROM year_balances WHERE employee_id = 'mm' AND year = 2026;
-- vacation_entitlement: 23, vacation_carryover: 0, overtime_carryover: 13
```

---

## Test Group 8: Employee Lifecycle

### Before
- 6 active employees with contracts
- No terminated employees
- No rehired employees

### Changes Made
1. **Hire new employee mid-month** (Julia, 2025-09-01)
   - Pro-rata: 4 months remaining = 7.7 days (23 × 4/12)
   - Contract created from hire date
2. **Terminate employee** (Peter, 2025-10-31)
   - Close contract (effective_to = 2025-10-31)
   - Record final payout (balance_adjustment)
3. **Rehire employee after gap** (Julia again, 2026-03-01)
   - Status: active again
   - New contract from rehire date
   - Fresh 2026 balance (pro-rata: 10 months)

### After
- Julia (hired 2025-09-01): 2025 balance = 7.7 days (pro-rata)
- Peter (terminated 2025-10-31): Contract closed, payout recorded
- Julia (rehired 2026-03-01): New contract, fresh 2026 balance = ~19 days (10 months pro-rata)

**Key Data State**:
```sql
-- New hire mid-month
SELECT employee_id, year, vacation_entitlement FROM year_balances
WHERE employee_id = 'new1' AND year = 2025;
-- vacation_entitlement: 7.7 (pro-rata)

-- Terminated employee
SELECT status, effective_to FROM employees e
JOIN employment_contracts ec ON e.id = ec.employee_id
WHERE e.id = 'pk' AND ec.effective_to IS NOT NULL;
-- status: terminated, effective_to: 2025-10-31

-- Rehired employee  
SELECT * FROM year_balances
WHERE employee_id = 'new1' AND year = 2026;
-- New balance created, pro-rata from 2026-03-01
```

---

## Test Group 9: Edge Cases

### Before
- 1 policy (v1, no overlaps)
- Standard time entries
- No leap year entries
- No year boundary entries
- No duplicate entries

### Changes Made
1. **Leap year test** (2025-02-29) → Entry accepted in leap year 2028
2. **Year boundary test** (2025-12-31 & 2026-01-01) → Both entries created with correct policy refs
3. **Duplicate prevention test** (insert same date twice) → Second rejected by UNIQUE
4. **No policy test** (date with no active policy) → Entry blocked
5. **Overlapping policy test** (v1 and v2 both active on 2025-06-15) → Detected by integrity check
6. **Missing clock times test** (no clock_in/clock_out) → Validation blocks
7. **Missing year balance test** (query non-existent year) → Returns null gracefully
8. **Future policy test** (entry on future date doesn't get future policy) → Policy lookup correct

### After
- Leap year entry: Stored and queryable
- Year boundary: Both entries exist with correct policy_id
- Duplicate: Rejected (UNIQUE constraint)
- Missing policy: No entry created
- Overlapping policies: Detected (overlap detection logic works)
- Missing clock times: No entry created (validation passed)
- Missing balance: Null returned (safe)
- Future policy: Correct policy used (not future)

**Key Data State**:
```sql
-- Leap year entry
SELECT COUNT(*) FROM time_entries WHERE work_date = '2028-02-29';
-- Result: 1 (accepted)

-- Year boundary
SELECT work_date, policy_id FROM time_entries
WHERE work_date IN ('2025-12-31', '2026-01-01');
-- Both exist with policy_id = 1 (v1 active on both dates)

-- Duplicate check
-- SELECT fails on unique (employee_id, work_date, entry_type)

-- Overlap detection
SELECT * FROM company_policies
WHERE effective_from < ? AND effective_to > ?
  AND id != ?
-- Shows overlapping policies (if any)
```

---

## Summary: Data State Changes Across All Groups

| Group | Key Changes | Data Impact |
|-------|-------------|-------------|
| **4** | Add premium entries + policy versions | Policies: 1→4; Entries: +20; Policy history proven |
| **2** | Create v2 policy, close v1 | Policies: 4→5; Policy v1 frozen; v2 active; 2026 balance = 28 days |
| **3** | Change Anna's contract 80%→60% | Contracts: +1; Same 8h = diff OT; 2026 balance = 13.8 days |
| **5** | Log vacation + adjustments | Entries: +10; Adjustments: +3; Balance tracked |
| **6** | Log OT + compensation | Entries: +7; Adjustments: +2; OT balance = 13h → −3h |
| **7** | Lazy init 2026 balances | Balances: +1; 2026 uses v2 rules; Carryover calculated |
| **8** | Hire, terminate, rehire | Employees: +1 (Julia); Contracts: +2; Balances: pro-rata applied |
| **9** | Edge case coverage | Entries: various edge cases; No data corruption |

---

## How to Use These Snapshots

1. **Run test group** (e.g., `node test-premiums.js`)
2. **Query "Before" state** in database (should match snapshot)
3. **Inspect "Changes Made"** section
4. **Query "After" state** (should match snapshot)
5. **Compare results** to validate test outcomes

---

## Recovery: Reset to Initial State

```bash
# Any time, reset to baseline:
node schema.js
node seed.js

# Then run any test group
node test-premiums.js
```

Each test group starts from fresh seed state.

---

*Generated April 7, 2026 | Use with README.md for complete testing workflow*
