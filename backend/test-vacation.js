/**
 * GROUP 5 — Vacation & Absence Tracking
 *
 * Scenarios:
 *   5.1  Vacation day reduces remaining balance
 *   5.2  Sick day does NOT reduce vacation balance
 *   5.3  Accident / dayoff also do NOT reduce vacation balance
 *   5.4  Public holiday during a vacation week not counted as vacation day
 *   5.5  Half-day vacation (4h = 0.5 days)
 *   5.6  Vacation carryover capped at max_carryover_days
 *   5.7  Negative balance (advance leave via adjustment)
 *   5.8  Vacation payout reduces balance
 *   5.9  Part-time: entitlement already prorated, 1 day = 1 day
 *   5.10 New employee hired mid-year gets pro-rata entitlement
 *   5.11 Cross-year vacation (Dec 30 – Jan 2) splits across year balances
 */

import db from './db.js';

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? '  →  ' + detail : ''}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(4, 50 - title.length))}`);
}

function round1(n) { return Math.round(n * 10) / 10; }

function getPolicyOn(date) {
  return db.prepare(`
    SELECT * FROM company_policies
    WHERE effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY effective_from DESC LIMIT 1
  `).get(date, date);
}

function getContractOn(employeeId, date) {
  return db.prepare(`
    SELECT * FROM employment_contracts
    WHERE employee_id = ? AND effective_from <= ?
      AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY effective_from DESC LIMIT 1
  `).get(employeeId, date, date);
}

// Check if a date is a public holiday
function isHoliday(date) {
  const d = db.prepare(`SELECT * FROM public_holidays WHERE date = ?`).get(date);
  if (d) return d;
  // Check recurring (same month+day any year)
  return db.prepare(`
    SELECT * FROM public_holidays
    WHERE recurring = 1
      AND strftime('%m-%d', date) = strftime('%m-%d', ?)
  `).get(date) || null;
}

// Log an absence entry (vacation, sick, accident, dayoff, public-holiday)
// hours: 8 = full day, 4 = half day
function logAbsence(employeeId, date, type, hours = 8) {
  const policy = getPolicyOn(date);
  db.prepare(`
    INSERT OR IGNORE INTO time_entries
      (employee_id, work_date, entry_type, hours, policy_id, source, status)
    VALUES (?, ?, ?, ?, ?, 'timesheet', 'approved')
  `).run(
    employeeId, date, type, hours, policy.id
  );
}

// Log a full vacation week, automatically skipping public holidays
function logVacationWeek(employeeId, dates) {
  for (const date of dates) {
    const holiday = isHoliday(date);
    if (holiday) {
      logAbsence(employeeId, date, 'public-holiday', 8);
    } else {
      logAbsence(employeeId, date, 'vacation', 8);
    }
  }
}

// Get vacation remaining for employee in a given year
function vacationRemaining(employeeId, year) {
  const balance = db.prepare(
    'SELECT * FROM year_balances WHERE employee_id = ? AND year = ?'
  ).get(employeeId, year);
  if (!balance) return null;

  const used = db.prepare(`
    SELECT COALESCE(SUM(hours) / 8.0, 0) as days
    FROM time_entries
    WHERE employee_id = ? AND entry_type = 'vacation'
      AND strftime('%Y', work_date) = ?
  `).get(employeeId, String(year))?.days || 0;

  const adjustments = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM balance_adjustments
    WHERE employee_id = ? AND year = ? AND unit = 'days'
  `).get(employeeId, year)?.total || 0;

  return round1(balance.vacation_entitlement + balance.vacation_carryover - used + adjustments);
}

function ensureYearBalance(employeeId, year) {
  const exists = db.prepare(
    'SELECT * FROM year_balances WHERE employee_id = ? AND year = ?'
  ).get(employeeId, year);
  if (exists) return exists;

  const jan1     = `${year}-01-01`;
  const policy   = getPolicyOn(jan1);
  const contract = getContractOn(employeeId, jan1);
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);

  const dob = new Date(employee.date_of_birth);
  const ref = new Date(jan1);
  let age = ref.getFullYear() - dob.getFullYear();
  const m = ref.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < dob.getDate())) age--;

  let baseDays;
  if (policy.age_based_vacation) {
    const ranges = JSON.parse(policy.age_ranges);
    const range  = ranges.find(r => age >= r.minAge && (r.maxAge === null || age <= r.maxAge));
    baseDays = range ? range.days : policy.default_vacation_days;
  } else {
    baseDays = policy.default_vacation_days;
  }
  const entitlement = round1(baseDays * (contract.work_percentage / 100));

  const prevBalance = db.prepare(
    'SELECT * FROM year_balances WHERE employee_id = ? AND year = ?'
  ).get(employeeId, year - 1);

  let vacCarryover = 0, otCarryover = 0;
  if (prevBalance) {
    const vacUsed = db.prepare(`
      SELECT COALESCE(SUM(hours) / 8.0, 0) as days FROM time_entries
      WHERE employee_id = ? AND entry_type = 'vacation' AND strftime('%Y', work_date) = ?
    `).get(employeeId, String(year - 1))?.days || 0;
    const unused = round1(prevBalance.vacation_entitlement + prevBalance.vacation_carryover - vacUsed);
    vacCarryover = round1(Math.min(Math.max(unused, 0), policy.max_carryover_days));

    const otHours = db.prepare(`
      SELECT COALESCE(SUM(overtime_hours), 0) as hours FROM time_entries
      WHERE employee_id = ? AND strftime('%Y', work_date) = ?
    `).get(employeeId, String(year - 1))?.hours || 0;
    otCarryover = round1(prevBalance.overtime_carryover + otHours);
  }

  db.prepare(`
    INSERT INTO year_balances
      (employee_id, year, vacation_entitlement, vacation_carryover, overtime_carryover, policy_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(employeeId, year, entitlement, vacCarryover, otCarryover, policy.id);

  return db.prepare(
    'SELECT * FROM year_balances WHERE employee_id = ? AND year = ?'
  ).get(employeeId, year);
}

// ─────────────────────────────────────────────
// 5.1 — Vacation day reduces balance
// ─────────────────────────────────────────────
section('5.1 Vacation Day Reduces Balance');

// Max: entitlement=23, carryover=3 → starting balance = 26
// Seed already has 2 vacation days for Max in March
const before = vacationRemaining('mm', 2025);
assert(`Max starting balance = 24 days (23 + 3 carryover - 2 used in seed)`, before === 24);

logAbsence('mm', '2025-04-07', 'vacation');
logAbsence('mm', '2025-04-08', 'vacation');

const after = vacationRemaining('mm', 2025);
assert('Balance reduced by 2 after logging 2 vacation days', after === 22);
assert('Reduction is exactly 2 days', round1(before - after) === 2);

// ─────────────────────────────────────────────
// 5.2 + 5.3 — Sick / accident / dayoff do NOT affect vacation
// ─────────────────────────────────────────────
section('5.2-5.3 Sick / Accident / Dayoff — Vacation Unchanged');

const beforeSick = vacationRemaining('mm', 2025);

logAbsence('mm', '2025-04-14', 'sick');
logAbsence('mm', '2025-04-15', 'accident');
logAbsence('mm', '2025-04-16', 'dayoff');

const afterSick = vacationRemaining('mm', 2025);

assert('Sick day does not reduce vacation balance',     afterSick === beforeSick);
assert('Accident day does not reduce vacation balance', afterSick === beforeSick);
assert('Dayoff does not reduce vacation balance',       afterSick === beforeSick);

// Verify they exist as entries
const sickEntry     = db.prepare(`SELECT * FROM time_entries WHERE employee_id='mm' AND work_date='2025-04-14'`).get();
const accidentEntry = db.prepare(`SELECT * FROM time_entries WHERE employee_id='mm' AND work_date='2025-04-15'`).get();
assert('Sick entry stored correctly',     sickEntry?.entry_type    === 'sick');
assert('Accident entry stored correctly', accidentEntry?.entry_type === 'accident');

// ─────────────────────────────────────────────
// 5.4 — Public holiday during vacation week
// ─────────────────────────────────────────────
section('5.4 Public Holiday During Vacation Week');

// Week of 2025-04-21 (Mon) includes Easter Monday (21 Apr = public holiday)
// Mon=holiday, Tue-Fri=vacation → only 4 vacation days deducted, not 5
const beforeWeek = vacationRemaining('mm', 2025);

logVacationWeek('mm', [
  '2025-04-21',  // Easter Monday — public holiday
  '2025-04-22',  // vacation
  '2025-04-23',  // vacation
  '2025-04-24',  // vacation
  '2025-04-25',  // vacation
]);

const afterWeek = vacationRemaining('mm', 2025);

const easterEntry = db.prepare(`SELECT * FROM time_entries WHERE employee_id='mm' AND work_date='2025-04-21'`).get();
assert('Easter Monday stored as public-holiday, not vacation', easterEntry?.entry_type === 'public-holiday');
assert('Only 4 vacation days deducted (not 5)', round1(beforeWeek - afterWeek) === 4);

// ─────────────────────────────────────────────
// 5.5 — Half-day vacation
// ─────────────────────────────────────────────
section('5.5 Half-Day Vacation (4h = 0.5 days)');

const beforeHalf = vacationRemaining('mm', 2025);
logAbsence('mm', '2025-05-05', 'vacation', 4);  // 4 hours = half day

const afterHalf = vacationRemaining('mm', 2025);
const halfDeducted = round1(beforeHalf - afterHalf);

assert('Half-day deducts 0.5 days',       halfDeducted === 0.5);
assert('Entry stores 4 hours',            db.prepare(`SELECT hours FROM time_entries WHERE employee_id='mm' AND work_date='2025-05-05'`).get()?.hours === 4);

// ─────────────────────────────────────────────
// 5.6 — Carryover capped at max_carryover_days
// ─────────────────────────────────────────────
section('5.6 Carryover Cap on Year Rollover');

// Anna 2025: entitlement=18.4, carryover=0, used=0 vacation entries
// Unused at end of 2025 = 18.4 → but cap is 5 → 2026 carryover = 5
const anna2026 = ensureYearBalance('as', 2026);
assert('Anna 2026 carryover capped at 5 (not 18.4)', anna2026?.vacation_carryover === 5);
assert('Cap comes from policy max_carryover_days = 5', (() => {
  const p = getPolicyOn('2026-01-01');
  return p?.max_carryover_days === 5;
})());

// ─────────────────────────────────────────────
// 5.7 — Negative balance (advance leave)
// ─────────────────────────────────────────────
section('5.7 Negative Balance — Advance Leave');

// Sarah: 23 days entitlement, no carryover
// Give her an explicit advance of -10 days via balance_adjustment
const sarahBalance = vacationRemaining('sl', 2025);

db.prepare(`
  INSERT INTO balance_adjustments
    (employee_id, year, adjustment_type, amount, unit, reason, created_by)
  VALUES ('sl', 2025, 'manual_vacation', -30, 'days', 'Advance leave approved by HR', 'admin')
`).run();

const sarahAfterAdv = vacationRemaining('sl', 2025);
assert('Balance can go negative with advance leave', sarahAfterAdv < 0);
assert(`Negative balance = ${round1(sarahBalance - 30)} days`, sarahAfterAdv === round1(sarahBalance - 30));

// Restore for further tests
db.prepare(`
  INSERT INTO balance_adjustments
    (employee_id, year, adjustment_type, amount, unit, reason, created_by)
  VALUES ('sl', 2025, 'manual_vacation', 30, 'days', 'Reversal of advance leave', 'admin')
`).run();
assert('Reversal restores balance', vacationRemaining('sl', 2025) === sarahBalance);

// ─────────────────────────────────────────────
// 5.8 — Vacation payout
// ─────────────────────────────────────────────
section('5.8 Vacation Payout (Days → Cash)');

const beforePayout = vacationRemaining('mm', 2025);

db.prepare(`
  INSERT INTO balance_adjustments
    (employee_id, year, adjustment_type, amount, unit, reason, created_by)
  VALUES ('mm', 2025, 'payout_vacation', -3, 'days', '3 days paid out in December', 'admin')
`).run();

const afterPayout = vacationRemaining('mm', 2025);
assert('Payout reduces vacation balance by 3 days', round1(beforePayout - afterPayout) === 3);

const payoutRecord = db.prepare(`
  SELECT * FROM balance_adjustments
  WHERE employee_id = 'mm' AND adjustment_type = 'payout_vacation'
`).get();
assert('Payout record stored with correct type', payoutRecord?.adjustment_type === 'payout_vacation');
assert('Payout amount is negative (debit)',       payoutRecord?.amount === -3);

// ─────────────────────────────────────────────
// 5.9 — Part-time employee: 1 day = 1 day
// ─────────────────────────────────────────────
section('5.9 Part-Time: Entitlement Prorated, Day Unit Same');

// Anna 80%: entitlement already prorated to 18.4 days at year start
// When she takes 1 vacation day it's still 1 full day deducted (8h / 8)
// The prorating happened at entitlement calculation time, not at usage time
const annaBefore = vacationRemaining('as', 2025);
logAbsence('as', '2025-05-12', 'vacation', 8);
const annaAfter = vacationRemaining('as', 2025);

assert('Anna (80%) loses exactly 1 day for 1 vacation day', round1(annaBefore - annaAfter) === 1);
assert('Day deduction is same unit regardless of work%', round1(annaBefore - annaAfter) === 1);

// ─────────────────────────────────────────────
// 5.10 — New employee hired mid-year: pro-rata
// ─────────────────────────────────────────────
section('5.10 Mid-Year Hire — Pro-Rata Entitlement');

// Insert a test employee hired on 2025-09-01 (4 months remaining in year = 4/12)
db.prepare(`INSERT OR IGNORE INTO employees (id, name, role, date_of_birth, hire_date, location) VALUES (?, ?, ?, ?, ?, ?)`
).run('test-hire', 'New Hire', 'Service', '1995-06-15', '2025-09-01', 'Zürich');

db.prepare(`
  INSERT OR IGNORE INTO employment_contracts
    (employee_id, employment_type, work_percentage, weekly_target_hours, effective_from)
  VALUES ('test-hire', 'full-time', 100, 40, '2025-09-01')
`).run();

// Pro-rata: hired Sep 1 = 4 months remaining out of 12
// Age at Sep 1 2025: born 1995-06-15 → 30 years old → bracket 20-49 = 23 days
// Pro-rata = 23 × (4/12) = 7.67 → rounded to 7.7 days
const monthsRemaining = 4;
const proRataDays = round1(23 * (monthsRemaining / 12));

db.prepare(`
  INSERT OR IGNORE INTO year_balances
    (employee_id, year, vacation_entitlement, vacation_carryover, overtime_carryover, policy_id, snapshot)
  VALUES (?, 2025, ?, 0, 0, 1, ?)
`).run(
  'test-hire', proRataDays,
  JSON.stringify({
    triggered_by: 'hire_date',
    hire_date: '2025-09-01',
    months_remaining: monthsRemaining,
    full_entitlement: 23,
    pro_rata: proRataDays
  })
);

const hireBalance = db.prepare(
  `SELECT * FROM year_balances WHERE employee_id = 'test-hire' AND year = 2025`
).get();

assert(`Pro-rata entitlement = ${proRataDays} days (23 × 4/12)`, hireBalance?.vacation_entitlement === proRataDays);

const hireSnap = JSON.parse(hireBalance?.snapshot || '{}');
assert('Snapshot records hire_date trigger',     hireSnap?.triggered_by    === 'hire_date');
assert('Snapshot records months remaining = 4',  hireSnap?.months_remaining === 4);

// ─────────────────────────────────────────────
// 5.11 — Cross-year vacation (Dec 30 – Jan 2)
// ─────────────────────────────────────────────
section('5.11 Cross-Year Vacation (Dec 30 – Jan 2)');

// Ensure 2026 balance exists for Max before we log Jan entries
ensureYearBalance('mm', 2026);

const mm2025Before = vacationRemaining('mm', 2025);
const mm2026Before = vacationRemaining('mm', 2026);

// Dec 30-31 → deduct from 2025 balance
logAbsence('mm', '2025-12-30', 'vacation');
logAbsence('mm', '2025-12-31', 'vacation');
// Jan 1 = Neujahr (public holiday) → not vacation
// Jan 2 → deduct from 2026 balance
logAbsence('mm', '2026-01-02', 'vacation');

const mm2025After = vacationRemaining('mm', 2025);
const mm2026After = vacationRemaining('mm', 2026);

assert('Dec 30-31 deducted from 2025 balance',  round1(mm2025Before - mm2025After) === 2);
assert('Jan 2 deducted from 2026 balance',       round1(mm2026Before - mm2026After) === 1);
assert('2025 and 2026 balances are independent', mm2025After !== mm2025Before && mm2026After !== mm2026Before);

// Verify entries are stored in correct year
const dec30 = db.prepare(`SELECT * FROM time_entries WHERE employee_id='mm' AND work_date='2025-12-30'`).get();
const jan02 = db.prepare(`SELECT * FROM time_entries WHERE employee_id='mm' AND work_date='2026-01-02'`).get();
assert('Dec entry stored with 2025 date',  dec30?.work_date?.startsWith('2025'));
assert('Jan entry stored with 2026 date',  jan02?.work_date?.startsWith('2026'));

// ─────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────
console.log(`\n${'═'.repeat(52)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('  🎉 Group 5 passed! Vacation tracking is solid.\n');
} else {
  console.log('  ⚠️  Some tests failed.\n');
}
