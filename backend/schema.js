import db from './db.js';

// Drop all tables and recreate fresh
db.exec(`
  DROP TABLE IF EXISTS balance_adjustments;
  DROP TABLE IF EXISTS year_balances;
  DROP TABLE IF EXISTS time_entries;
  DROP TABLE IF EXISTS public_holidays;
  DROP TABLE IF EXISTS company_policies;
  DROP TABLE IF EXISTS employment_contracts;
  DROP TABLE IF EXISTS employees;
`);

db.exec(`

  -- ─────────────────────────────────────────────
  -- EMPLOYEES
  -- Master record. Never updated after insert.
  -- ─────────────────────────────────────────────
  CREATE TABLE employees (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL,
    date_of_birth DATE NOT NULL,
    hire_date   DATE NOT NULL,
    location    TEXT,
    status      TEXT NOT NULL DEFAULT 'active',  -- active | terminated | on-leave
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  -- ─────────────────────────────────────────────
  -- EMPLOYMENT CONTRACTS
  -- Versioned. Each change = new row.
  -- Handles full-time ↔ part-time switches.
  -- ─────────────────────────────────────────────
  CREATE TABLE employment_contracts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id       TEXT NOT NULL REFERENCES employees(id),
    employment_type   TEXT NOT NULL,   -- full-time | part-time | intern
    work_percentage   INTEGER NOT NULL, -- 100, 80, 60, etc.
    weekly_target_hours REAL NOT NULL,  -- actual hours expected (e.g. 32 for 80%)
    effective_from    DATE NOT NULL,
    effective_to      DATE,            -- NULL = currently active
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  -- ─────────────────────────────────────────────
  -- COMPANY POLICIES
  -- Versioned. All business rules live here.
  -- One row per version. effective_to NULL = active.
  -- ─────────────────────────────────────────────
  CREATE TABLE company_policies (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    version                 INTEGER NOT NULL DEFAULT 1,
    -- Working hours
    weekly_hours            REAL NOT NULL DEFAULT 40,
    max_weekly_hours        REAL NOT NULL DEFAULT 48,
    daily_hours             REAL NOT NULL DEFAULT 8,
    -- Vacation rules
    age_based_vacation      INTEGER NOT NULL DEFAULT 1,  -- 1=true, 0=false
    default_vacation_days   INTEGER NOT NULL DEFAULT 25,
    age_ranges              TEXT NOT NULL,               -- JSON array [{minAge, maxAge, days}]
    carryover_allowed       INTEGER NOT NULL DEFAULT 1,
    max_carryover_days      INTEGER NOT NULL DEFAULT 5,
    -- Premium rates
    premium_rates           TEXT NOT NULL,               -- JSON {overtime, extratime, holiday, sunday, night}
    -- Versioning
    effective_from          DATE NOT NULL,
    effective_to            DATE,                        -- NULL = currently active
    change_reason           TEXT,
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  -- ─────────────────────────────────────────────
  -- PUBLIC HOLIDAYS
  -- Simple calendar. No versioning needed.
  -- ─────────────────────────────────────────────
  CREATE TABLE public_holidays (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        DATE NOT NULL,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'public',  -- public | company | floating
    recurring   INTEGER NOT NULL DEFAULT 1,      -- 1 = repeats every year same date
    region      TEXT DEFAULT 'CH'
  );

  -- ─────────────────────────────────────────────
  -- TIME ENTRIES
  -- Single source of truth for what happened.
  -- Calculation RESULTS stored once at submit, never changed.
  -- Policy RULES queried via JOIN to company_policies on policy_id + date range.
  -- ─────────────────────────────────────────────
  CREATE TABLE time_entries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id   TEXT NOT NULL REFERENCES employees(id),
    work_date     DATE NOT NULL,
    -- What happened that day
    entry_type    TEXT NOT NULL,  -- work | vacation | sick | accident | dayoff | public-holiday | compensation
    -- Only filled for entry_type = 'work'
    clock_in      TEXT,           -- HH:MM
    clock_out     TEXT,           -- HH:MM
    break_minutes INTEGER DEFAULT 0,
    -- Stored RESULTS (calculated once at submit, never recalculated)
    hours         REAL NOT NULL DEFAULT 0,
    regular_hours REAL DEFAULT 0,
    overtime_hours REAL DEFAULT 0,
    extratime_hours REAL DEFAULT 0,
    -- Premiums (hours eligible for premium pay)
    holiday_premium REAL DEFAULT 0,
    sunday_premium  REAL DEFAULT 0,
    night_premium   REAL DEFAULT 0,
    -- Policy reference (rules queried via JOIN)
    policy_id     INTEGER NOT NULL REFERENCES company_policies(id),
    -- Workflow
    source        TEXT DEFAULT 'timesheet',  -- timesheet | schedule
    status        TEXT DEFAULT 'draft',      -- draft | submitted | approved
    note          TEXT,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    approved_by   TEXT,
    approved_at   TIMESTAMP,
    UNIQUE(employee_id, work_date, entry_type)
  );

  -- ─────────────────────────────────────────────
  -- YEAR BALANCES
  -- Snapshot at start of each year per employee.
  -- Captures carryovers and annual entitlement.
  -- ─────────────────────────────────────────────
  CREATE TABLE year_balances (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id           TEXT NOT NULL REFERENCES employees(id),
    year                  INTEGER NOT NULL,
    -- Vacation
    vacation_entitlement  REAL NOT NULL,   -- days granted this year (policy + age/tenure)
    vacation_carryover    REAL DEFAULT 0,  -- days brought in from prev year
    -- Overtime
    overtime_carryover    REAL DEFAULT 0,  -- hours brought in from prev year
    -- Context
    policy_id             INTEGER REFERENCES company_policies(id),
    snapshot              TEXT,            -- JSON: what rules generated these values
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(employee_id, year)
  );

  -- ─────────────────────────────────────────────
  -- BALANCE ADJUSTMENTS
  -- Manual corrections, payouts, compensation.
  -- Every change to balances outside normal entries.
  -- ─────────────────────────────────────────────
  CREATE TABLE balance_adjustments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id   TEXT NOT NULL REFERENCES employees(id),
    year          INTEGER NOT NULL,
    adjustment_type TEXT NOT NULL,  -- manual_vacation | manual_overtime | payout_vacation | payout_overtime | compensation_from_overtime
    amount        REAL NOT NULL,    -- positive = credit, negative = debit (days or hours)
    unit          TEXT NOT NULL,    -- days | hours
    reason        TEXT,
    created_by    TEXT NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

`);

console.log('✅ Schema created successfully.');
console.log('   Tables: employees, employment_contracts, company_policies,');
console.log('           public_holidays, time_entries, year_balances, balance_adjustments\n');
