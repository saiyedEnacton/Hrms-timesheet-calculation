import db from './db.js';

// ─────────────────────────────────────────────
// COMPANY POLICY (v1 - active from 2024-01-01)
// Mirrors what CompanySettingsContext has as defaults
// ─────────────────────────────────────────────
const insertPolicy = db.prepare(`
  INSERT INTO company_policies (
    version, weekly_hours, max_weekly_hours, daily_hours,
    age_based_vacation, default_vacation_days, age_ranges,
    carryover_allowed, max_carryover_days,
    premium_rates, effective_from, change_reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

insertPolicy.run(
  1, 40, 48, 8,
  1, 25,
  JSON.stringify([
    { minAge: 18, maxAge: 19, days: 29 },
    { minAge: 20, maxAge: 49, days: 23 },
    { minAge: 50, maxAge: null, days: 29 }
  ]),
  1, 5,
  JSON.stringify({
    overtime:  { enabled: true, rate: 0,   threshold: 40 },  // tracked, no pay
    extratime: { enabled: true, rate: 25,  threshold: 48 },  // 25% above 48h
    holiday:   { enabled: true, rate: 100 },
    sunday:    { enabled: true, rate: 100 },
    night:     { enabled: true, rate: 25, startTime: '23:00', endTime: '06:00' }
  }),
  '2024-01-01',
  'Initial policy'
);

const policy = db.prepare('SELECT id FROM company_policies ORDER BY id DESC LIMIT 1').get();
const policyId = policy.id;
console.log(`✅ Policy v1 created (id: ${policyId})`);

// ─────────────────────────────────────────────
// PUBLIC HOLIDAYS (Swiss 2025)
// ─────────────────────────────────────────────
const insertHoliday = db.prepare(`
  INSERT INTO public_holidays (date, name, type, recurring, region) VALUES (?, ?, ?, ?, ?)
`);

const holidays = [
  ['2025-01-01', 'Neujahr',       'public', 1, 'CH'],
  ['2025-01-02', 'Berchtoldstag', 'public', 1, 'CH'],
  ['2025-04-18', 'Karfreitag',    'public', 0, 'CH'],
  ['2025-04-21', 'Ostermontag',   'public', 0, 'CH'],
  ['2025-05-01', 'Tag der Arbeit','public', 1, 'CH'],
  ['2025-05-29', 'Auffahrt',      'public', 0, 'CH'],
  ['2025-06-09', 'Pfingstmontag', 'public', 0, 'CH'],
  ['2025-08-01', 'Bundesfeier',   'public', 1, 'CH'],
  ['2025-12-25', 'Weihnachten',   'public', 1, 'CH'],
  ['2025-12-26', 'Stephanstag',   'public', 1, 'CH'],
];

for (const h of holidays) insertHoliday.run(...h);
console.log(`✅ ${holidays.length} public holidays inserted`);

// ─────────────────────────────────────────────
// EMPLOYEES (matching the React prototype)
// ─────────────────────────────────────────────
const insertEmployee = db.prepare(`
  INSERT INTO employees (id, name, role, date_of_birth, hire_date, location, status)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertContract = db.prepare(`
  INSERT INTO employment_contracts
    (employee_id, employment_type, work_percentage, weekly_target_hours, effective_from)
  VALUES (?, ?, ?, ?, ?)
`);

const insertYearBalance = db.prepare(`
  INSERT INTO year_balances
    (employee_id, year, vacation_entitlement, vacation_carryover, overtime_carryover, policy_id, snapshot)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// Helper: get vacation days from policy age ranges
function getVacationDays(age) {
  if (age >= 18 && age <= 19) return 29;
  if (age >= 20 && age <= 49) return 23;
  if (age >= 50) return 29;
  return 25;
}

function calcAge(dob) {
  const today = new Date('2025-01-01');
  const birth = new Date(dob);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

const employees = [
  { id: 'mm', name: 'Max Müller',    role: 'Service', dob: '1997-03-15', hire: '2024-12-01', type: 'full-time',  pct: 100, ot_carry: 8,   vac_carry: 3  },
  { id: 'as', name: 'Anna Schmidt',  role: 'Küche',   dob: '1990-07-22', hire: '2025-01-01', type: 'part-time',  pct: 80,  ot_carry: 0,   vac_carry: 0  },
  { id: 'pk', name: 'Peter Keller',  role: 'Bar',     dob: '1973-11-08', hire: '2025-03-01', type: 'full-time',  pct: 100, ot_carry: 0,   vac_carry: 0  },
  { id: 'sl', name: 'Sarah Lang',    role: 'Service', dob: '2001-05-14', hire: '2025-07-01', type: 'full-time',  pct: 100, ot_carry: 0,   vac_carry: 0  },
  { id: 'tw', name: 'Thomas Weber',  role: 'Küche',   dob: '1980-02-28', hire: '2025-09-01', type: 'part-time',  pct: 60,  ot_carry: 0,   vac_carry: 0  },
  { id: 'lm', name: 'Lisa Meier',    role: 'Service', dob: '2006-09-03', hire: '2025-12-01', type: 'intern',     pct: 100, ot_carry: 0,   vac_carry: 0  },
];

for (const emp of employees) {
  insertEmployee.run(emp.id, emp.name, emp.role, emp.dob, emp.hire, 'Zürich', 'active');

  const weeklyTarget = 40 * (emp.pct / 100);
  insertContract.run(emp.id, emp.type, emp.pct, weeklyTarget, emp.hire);

  const age = calcAge(emp.dob);
  const vacDays = Math.round(getVacationDays(age) * (emp.pct / 100) * 10) / 10;

  insertYearBalance.run(
    emp.id, 2025,
    vacDays,
    emp.vac_carry,
    emp.ot_carry,
    policyId,
    JSON.stringify({
      age_at_jan1: age,
      policy_version: 1,
      vacation_basis: `age ${age} → ${getVacationDays(age)} days × ${emp.pct}%`,
    })
  );
}

console.log(`✅ ${employees.length} employees + contracts + year balances inserted`);

// ─────────────────────────────────────────────
// SAMPLE TIME ENTRIES (a few weeks for mm + as)
// ─────────────────────────────────────────────
const insertEntry = db.prepare(`
  INSERT OR IGNORE INTO time_entries (
    employee_id, work_date, entry_type,
    clock_in, clock_out, break_minutes,
    hours, regular_hours, overtime_hours, extratime_hours,
    policy_id, source, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Max Müller - 2 weeks of 8.5h/day = 42.5h/week (overtime kicks in)
const maxEntries = [
  ['2025-03-03', '08:00', '17:00', 30, 8.5],
  ['2025-03-04', '08:00', '17:00', 30, 8.5],
  ['2025-03-05', '08:00', '17:00', 30, 8.5],
  ['2025-03-06', '08:00', '17:00', 30, 8.5],
  ['2025-03-07', '08:00', '17:00', 30, 8.5],  // week total: 42.5h → 2.5h overtime
  ['2025-03-10', '08:00', '17:00', 30, 8.5],
  ['2025-03-11', '08:00', '17:00', 30, 8.5],
  ['2025-03-12', '08:00', '17:00', 30, 8.5],
  ['2025-03-13', '08:00', '17:00', 30, 8.5],
  ['2025-03-14', '08:00', '17:00', 30, 8.5],  // week total: 42.5h → 2.5h overtime
];

for (const [date, ci, co, brk, hrs] of maxEntries) {
  // Weekly overtime: threshold is 40h/week = 8h/day, anything above is overtime
  const regular = Math.min(hrs, 8);
  const overtime = Math.max(0, hrs - 8);
  insertEntry.run(
    'mm', date, 'work', ci, co, brk,
    hrs, regular, overtime, 0,
    policyId, 'timesheet', 'approved'
  );
}

// Max - 2 vacation days
insertEntry.run('mm', '2025-03-17', 'vacation', null, null, 0, 8, 0, 0, 0, policyId, 'timesheet', 'approved');
insertEntry.run('mm', '2025-03-18', 'vacation', null, null, 0, 8, 0, 0, 0, policyId, 'timesheet', 'approved');

// Anna Schmidt - 80% = 32h/week, works Mon-Thu
const annaEntries = [
  ['2025-03-03', '09:00', '17:30', 30, 8.0],
  ['2025-03-04', '09:00', '17:30', 30, 8.0],
  ['2025-03-05', '09:00', '17:30', 30, 8.0],
  ['2025-03-06', '09:00', '17:30', 30, 8.0],  // 32h week - no overtime for 80% contract
  ['2025-03-10', '09:00', '17:30', 30, 8.0],
  ['2025-03-11', '09:00', '17:30', 30, 8.0],
  ['2025-03-12', '09:00', '17:30', 30, 8.0],
  ['2025-03-13', '09:00', '17:30', 30, 8.0],
];

for (const [date, ci, co, brk, hrs] of annaEntries) {
  // For 80% employee, overtime only after 32h/week (8h × 4 days)
  insertEntry.run(
    'as', date, 'work', ci, co, brk,
    hrs, hrs, 0, 0,
    policyId, 'timesheet', 'approved'
  );
}

// Anna - 1 sick day
insertEntry.run('as', '2025-03-07', 'sick', null, null, 0, 8, 0, 0, 0, policyId, 'timesheet', 'approved');

console.log('✅ Sample time entries inserted (Max: 10 work + 2 vacation, Anna: 8 work + 1 sick)\n');
console.log('Seed complete. Run node test.js to verify.\n');
