# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

This is a **schema design and testing environment** for HRMS (Human Resource Management System) timesheet and leave tracking functionality. The primary goal is to design and validate database schemas that maintain **temporal data integrity** and **historical accuracy** regardless of how business rules change over time.

### Core Repository Structure

- **Root directory**: `D:\saas\saasxpo-staging\HRMS-functionality`
- **React prototype**: `Deftimesheetaischedulecopyenactonuse/` - React/Vite UI for visualizing and testing timesheet logic
- **Backend testing**: Will use Node.js + SQLite (or similar) for schema validation
- **Documentation**: `hrms-feature.docx` and various `.md` files in `src/docs/`

## Critical Design Principles

### 1. Temporal Data Integrity (Most Important)

**The schema MUST ensure that historical data remains accurate even when business rules change.**

Example scenarios:
- If overtime rules change from "1.5x after 8 hours" to "1.5x after 40 hours weekly", old records must still show correct calculations using old rules
- If leave policy changes from age-based to tenure-based, historical leave records must reflect the policy that was active at that time
- If an employee's contract changes from full-time to part-time, past timesheet calculations must remain accurate

**Design Requirements:**
- Use **policy versioning** with effective dates (effective_from, effective_to)
- Store **calculated values at time of entry**, not recalculate on demand
- Maintain **snapshot of rules applied** with each transaction
- Use **immutable records** - never update, only insert new versions
- Record **who calculated, when, and under which rule version**

### 2. Point-in-Time Accuracy

Years later, you must be able to:
- View exact hours worked on any given day
- Distinguish regular hours vs overtime vs premium hours
- See which policy version was active
- Understand how calculations were derived
- Audit trail of all changes

### 3. Minimal Runtime Calculation

**Avoid on-the-fly calculations.** Calculate once, store the result with context.

- ❌ BAD: Query timesheets and calculate overtime on each page load
- ✅ GOOD: Calculate overtime when timesheet is submitted, store result with rule reference

No cron jobs or background recalculations. If rules change, old data stays unchanged; only new entries use new rules.

## Schema Design Testing Checklist

When designing or validating schemas, test these scenarios:

### Employee Lifecycle
- [ ] New employee hired mid-month - pro-rata leave calculation
- [ ] Employee contract change (full-time ↔ part-time)
- [ ] Employee role change with different overtime rules
- [ ] Employee termination - final settlement calculation
- [ ] Employee rehired after gap period

### Leave/Vacation Management
- [ ] Leave policy changes from age-based to tenure-based
- [ ] Annual leave carryover rules change
- [ ] New leave types added (sick, parental, sabbatical)
- [ ] Leave approval workflow changes
- [ ] Public holiday calendar updates mid-year
- [ ] Part-time employee leave calculations (% of full-time)

### Time Tracking & Overtime
- [ ] Overtime rule changes (daily vs weekly threshold)
- [ ] Premium rate changes (1.5x → 2.0x for weekends)
- [ ] New shift types added (night shift premium)
- [ ] Break time policy changes (paid vs unpaid)
- [ ] Rounding rules change (15min → 6min intervals)
- [ ] Retroactive timesheet corrections

### Policy Versioning
- [ ] Multiple policies active for different departments
- [ ] Policy change with transition period (grace period)
- [ ] Emergency policy override (pandemic, natural disaster)
- [ ] Regional policy variations (different offices)
- [ ] Employee-specific exceptions to standard policy

### Reporting & Compliance
- [ ] Historical report accuracy (audit from 5 years ago)
- [ ] Policy comparison reports (before/after rule change)
- [ ] Employee timesheet history with correct rule context
- [ ] Payroll export with all premium calculations explained
- [ ] Compliance audit trail (who approved what, when)

### Edge Cases
- [ ] Leap year handling
- [ ] Daylight saving time transitions
- [ ] Cross-year leave periods (Dec 30 - Jan 5)
- [ ] Concurrent leave and work-from-home
- [ ] Partial day leave (half-day, 2 hours, etc.)
- [ ] Negative balance scenarios (advance leave, overtime deficit)

## Required Schema Tables (Minimum)

Based on temporal integrity requirements:

### Core Tables
1. **employees** - Employee master data with versioning
2. **employment_contracts** - Contract history with effective dates
3. **time_entries** - Daily time records (immutable)
4. **calculated_entries** - Pre-calculated overtime/premium with rule reference
5. **leave_transactions** - Leave taken/accrued with policy reference
6. **leave_balances_snapshot** - Point-in-time balance records

### Policy Tables
7. **overtime_policies** - Overtime rules with version history
8. **leave_policies** - Leave rules with version history
9. **shift_types** - Shift definitions and premium rates
10. **public_holidays** - Holiday calendar with regional variants
11. **policy_assignments** - Which policy applies to which employee/department

### Audit Tables
12. **calculation_audit** - Record of all calculations performed
13. **rule_change_log** - History of all policy changes
14. **timesheet_approvals** - Approval workflow history

## Development Commands

### React Frontend (in Deftimesheetaischedulecopyenactonuse/)
```bash
npm install          # Install dependencies
npm run dev          # Start dev server (Vite)
npm run build        # Build for production
```

### Backend Testing (to be created)
```bash
# Node.js + SQLite setup
node --version       # Should be v20+
npm init -y          # Initialize backend
npm install sqlite3  # Or better-sqlite3

# Run schema tests
node test-schema.js           # Test basic schema
node test-policy-change.js    # Test policy versioning
node test-calculations.js     # Test overtime/leave calc
```

## Development Workflow

1. **Design Phase**: Document schema requirements and relationships
2. **Create Schema**: Write SQL DDL with version tracking built in
3. **Write Tests**: Create test cases for each checklist item
4. **Implement**: Build Node.js test scripts to validate schema
5. **Document**: Record findings and schema decisions
6. **Iterate**: Refine based on test results

## Key Files to Reference

- `src/EMPLOYEE_CONTEXT_DOCUMENTATION.md` - Current employee data structure
- `src/TIMESHEET_WORKFLOW_COMPLETE_ANALYSIS.md` - Timesheet workflow analysis
- `src/TIMESHEET_TESTING_GUIDE.md` - Testing scenarios
- `src/docs/ABSENCE_*.md` - Absence/leave integration docs
- `hrms-feature.docx` - Feature requirements (in parent directory)

## Schema Design Guidelines

### Every Transaction Must Include:
- `created_at` - When record was created (immutable)
- `effective_date` - Which date this applies to (business date)
- `policy_version_id` - Which policy was active
- `calculated_by` - System/user who performed calculation
- `calculation_snapshot` - JSON of how calculation was done

### For Policy Tables:
- `id` - Policy identifier
- `version` - Version number
- `effective_from` - Start date for this version
- `effective_to` - End date (NULL = currently active)
- `created_at` - When this version was created
- `created_by` - Who created this version
- `supersedes_policy_id` - Reference to previous version

### For Employee Data:
- Use **versioned records** not updates
- Track employment status changes
- Link to active policy assignments
- Maintain contract history

### For Calculations:
```sql
-- Example: Store calculation context
CREATE TABLE overtime_calculations (
  id INTEGER PRIMARY KEY,
  time_entry_id INTEGER,
  employee_id INTEGER,
  calculation_date DATE,
  regular_hours DECIMAL(5,2),
  overtime_hours DECIMAL(5,2),
  premium_hours DECIMAL(5,2),
  overtime_policy_id INTEGER,  -- Which rule was applied
  calculation_details JSON,     -- How it was calculated
  calculated_at TIMESTAMP,
  calculated_by VARCHAR(50),
  FOREIGN KEY (overtime_policy_id) REFERENCES overtime_policies(id)
);
```

## Testing Approach

### Manual Testing
1. Create sample employees with different contracts
2. Add time entries across multiple months
3. Change a policy mid-period
4. Verify old records unchanged
5. Verify new records use new policy
6. Generate historical reports and validate accuracy

### Automated Testing
- Write Node.js scripts that:
  - Insert test data
  - Change policies
  - Query historical data
  - Assert calculations match expected values
  - Verify no data corruption occurred

### Validation Queries
Create SQL queries to validate:
- No orphaned records
- Policy effective dates don't overlap
- All calculations have policy references
- Historical balances can be reconstructed
- Audit trail is complete

## Success Criteria

The schema is successful when:
1. ✅ You can change any business rule without affecting past data
2. ✅ You can audit any transaction from any point in time
3. ✅ Historical reports show exact calculations as they were
4. ✅ No runtime recalculations needed (all pre-calculated)
5. ✅ Clear audit trail for compliance
6. ✅ Handles all edge cases in checklist
7. ✅ Simple to query and understand
8. ✅ Performant even with years of data

## Anti-Patterns to Avoid

❌ Updating existing records instead of creating new versions
❌ Storing only current policy (no version history)
❌ Calculating on-the-fly without storing results
❌ Using soft deletes without proper versioning
❌ Missing effective date ranges
❌ No audit trail of who/when/why
❌ Assuming business rules are stable
❌ Over-normalizing at expense of query complexity
❌ Under-normalizing at expense of data integrity

## Notes

- This is a **testing and design project**, not production code
- Focus on schema correctness over performance optimization
- Prioritize data integrity over convenience
- Document all design decisions and trade-offs
- Use SQLite for simplicity, but design for PostgreSQL compatibility
- The React UI is for visualization only, not the source of truth
