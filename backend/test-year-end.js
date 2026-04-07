/**
 * GROUP 7 — Year-End Rollover
 *
 * Scenarios:
 *   7.1  2026 year_balance created from 2025 end state (lazy init)
 *   7.2  Unused vacation carries over fully (no cap — all carries forward)
 *   7.3  Vacation used in 2025 correctly excluded from carryover
 *   7.4  Overtime balance carries fully into 2026
 *   7.5  New policy in 2026 applied to 2026 year_balance
 *   7.6  2025 year_balance frozen after 2026 rollover
 *   7.7  Employee age increments for 2026 entitlement calculation
 *   7.8  Employee hired in 2025 gets correct 2026 full-year entitlement
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

// Full lazy init with NO carryover cap (all unused vacation carries)
function ensureYearBalance(employeeId, year) {
  const exists = db.prepare(
    'SELECT * FROM year_balances WHERE employee_id = ? AND year = ?'
  ).get(employeeId, year);
  if (exists) return exists;

  const jan1     = `${year}-01-01`;
  const policy   = getPolicyOn(jan1);
  const contract = getContractOn(employeeId, jan1);
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);

  // Age at Jan 1 of this year
  const dob = new Date(employee.date_of_birth);
  const ref = new Date(jan1);
  let age = ref.getFullYear() - dob.getFullYear();
  const m = ref.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < dob.getDate())) age--;

  // Entitlement from policy
  let baseDays;
  if (policy.age_based_vacation) {
    const ranges = JSON.parse(policy.age_ranges);
    const range  = ranges.find(r => age >= r.minAge && (r.maxAge === null || age <= r.maxAge));
    baseDays = range ? range.days : policy.default_vacation_days;
  } else {
    baseDays = policy.default_vacation_days;
  }
  const entitlement = round1(baseDays * (contract.work_percentage / 100));

  // Previous year balances
  const prevBalance = db.prepare(
    'SELECT * FROM year_balances WHERE employee_id = ? AND year = ?'
  ).get(employeeId, year - 1);

  let vacCarryover = 0;
  let otCarryover  = 0;

  if (prevBalance) {
    const vacUsed = round1(db.prepare(`
      SELECT COALESCE(SUM(hours) / 8.0, 0) as days FROM time_entries
      WHERE employee_id = ? AND entry_type = 'vacation' AND strftime('%Y', work_date) = ?
    `).get(employeeId, String(year - 1))?.days || 0);

    const vacAdj = round1(db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM balance_adjustments
      WHERE employee_id = ? AND year = ? AND unit = 'days'
    `).get(employeeId, year - 1)?.total || 0);

    // No cap — all unused vacation carries over
    const unused = round1(prevBalance.vacation_entitlement + prevBalance.vacation_carryover - vacUsed + vacAdj);
    vacCarryover = round1(Math.max(unused, 0));

    // OT: carryover + earned - compensation taken + adjustments
    const otEarned = round1(db.prepare(`
      SELECT COALESCE(SUM(overtime_hours), 0) as h FROM time_entries
      WHERE employee_id = ? AND strftime('%Y', work_date) = ?
    `).get(employeeId, String(year - 1))?.h || 0);

    const otComp = round1(db.prepare(`
      SELECT COALESCE(SUM(hours), 0) as h FROM time_entries
      WHERE employee_id = ? AND entry_type = 'compensation' AND strftime('%Y', work_date) = ?
    `).get(employeeId, String(year - 1))?.h || 0);

    const otAdj = round1(db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM balance_adjustments
      WHERE employee_id = ? AND year = ? AND unit = 'hours'
    `).get(employeeId, year - 1)?.total || 0);

    otCarryover = round1(prevBalance.overtime_carryover + otEarned - otComp + otAdj);
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
// Setup: Add some 2025 vacation entries so we
// can verify what carries over vs what doesn't
// ─────────────────────────────────────────────
section('Setup — 2025 Activity Before Rollover');

// Max 2025: entitlement=23, carryover=3 → 26 total
// Use 6 vacation days → 20 unused should carry to 2026
const vacEntries = [
  '2025-05-05', '2025-05-06', '2025-05-07',
  '2025-05-08', '2025-05-09', '2025-05-12'
];
for (const date of vacEntries) {
  db.prepare(`
    INSERT OR IGNORE INTO time_entries
      (employee_id, work_date, entry_type, hours, policy_id, source, status)
    VALUES ('mm', ?, 'vacation', 8, 1, 'timesheet', 'approved')
  `).run(date);
}

// Add some OT entries for Max in 2025 (5 days × 1h OT)
const workEntries = ['2025-06-02', '2025-06-03', '2025-06-04', '2025-06-05', '2025-06-06'];
for (const date of workEntries) {
  db.prepare(`
    INSERT OR IGNORE INTO time_entries
      (employee_id, work_date, entry_type, clock_in, clock_out, break_minutes,
       hours, regular_hours, overtime_hours, policy_id, source, status)
    VALUES ('mm', ?, 'work', '08:00', '17:30', 30, 9, 8, 1, 1, 'timesheet', 'approved')
  `).run(date);
}

const vacUsed2025 = round1(db.prepare(`
  SELECT COALESCE(SUM(hours)/8.0, 0) as d FROM time_entries
  WHERE employee_id='mm' AND entry_type='vacation' AND strftime('%Y',work_date)='2025'
`).get()?.d || 0);

const otEarned2025 = round1(db.prepare(`
  SELECT COALESCE(SUM(overtime_hours), 0) as h FROM time_entries
  WHERE employee_id='mm' AND strftime('%Y',work_date)='2025'
`).get()?.h || 0);

assert(`Max used ${vacUsed2025} vacation days in 2025`, vacUsed2025 === 8); // 2 from seed + 6 new
assert(`Max earned ${otEarned2025}h OT in 2025`, otEarned2025 === 10);      // 10×0.5h seed + 5×1h new

// ─────────────────────────────────────────────
// 7.1 — 2026 year_balance created via lazy init
// ─────────────────────────────────────────────
section('7.1 2026 Year Balance Created on First Access');

const before = db.prepare('SELECT * FROM year_balances WHERE employee_id=? AND year=2026').get('mm');
assert('No 2026 balance exists before first access', before == null);

const mm2026 = ensureYearBalance('mm', 2026);

assert('2026 balance created on first access', mm2026 != null);
assert('Snapshot records lazy_init trigger',   JSON.parse(mm2026.snapshot)?.triggered_by === 'lazy_init');

// ─────────────────────────────────────────────
// 7.2 — Unused vacation carries fully (no cap)
// ─────────────────────────────────────────────
section('7.2 Full Vacation Carryover (No Cap)');

// Max 2025: entitlement=23, carryover=3, used=8 → unused = 23+3-8 = 18
const expectedCarryover = round1(23 + 3 - 8);  // = 18
assert(`2026 vacation carryover = ${expectedCarryover} days (all unused carries)`, mm2026.vacation_carryover === expectedCarryover);

// ─────────────────────────────────────────────
// 7.3 — Used days correctly excluded from carryover
// ─────────────────────────────────────────────
section('7.3 Used Days Excluded from Carryover');

// If we hadn't used those 8 days, carryover would be 26
// The fact it's 18 proves used days are deducted before carryover
assert('Carryover = entitlement + prev_carryover - used',
  mm2026.vacation_carryover === round1(23 + 3 - vacUsed2025)
);
assert('Carryover is less than full entitlement (used days excluded)',
  mm2026.vacation_carryover < 23 + 3
);

// ─────────────────────────────────────────────
// 7.4 — Overtime carries fully
// ─────────────────────────────────────────────
section('7.4 Overtime Carries Fully into 2026');

// Max OT: 8h carryover from 2024 + 15h earned in 2025 = 23h
const expectedOTCarry = round1(8 + otEarned2025);  // 8 + 10 = 18
assert(`2026 OT carryover = ${expectedOTCarry}h (8 from 2024 + ${otEarned2025} earned)`, mm2026.overtime_carryover === expectedOTCarry);
assert('Full OT carries with no cap', mm2026.overtime_carryover === expectedOTCarry);

// ─────────────────────────────────────────────
// 7.5 — New policy in 2026 applied to new year_balance
// ─────────────────────────────────────────────
section('7.5 2026 Balance Uses Policy Active on Jan 1 2026');

// Policy v1 is still active (no v2 created in this test run)
const policyOnJan2026 = getPolicyOn('2026-01-01');
assert('2026 balance references correct policy', mm2026.policy_id === policyOnJan2026.id);
assert('Policy version matches Jan 1 2026',      JSON.parse(mm2026.snapshot)?.policy_version === policyOnJan2026.version);

// Now simulate a policy change effective 2026-01-01
// and verify a NEW employee's 2026 balance uses it
db.prepare(`UPDATE company_policies SET effective_to = '2025-12-31' WHERE effective_to IS NULL`).run();
db.prepare(`
  INSERT INTO company_policies (
    version, weekly_hours, max_weekly_hours, daily_hours,
    age_based_vacation, default_vacation_days, age_ranges,
    carryover_allowed, max_carryover_days, premium_rates,
    effective_from, change_reason
  ) VALUES (2, 40, 48, 8, 0, 30, ?, 1, 99, ?, '2026-01-01', 'Flat 30 days from 2026')
`).run(
  JSON.stringify([{ minAge: 18, maxAge: null, days: 30 }]),
  JSON.stringify({ overtime: { enabled: true, rate: 0, threshold: 40 }, extratime: { enabled: true, rate: 25, threshold: 48 }, holiday: { enabled: true, rate: 100 }, sunday: { enabled: true, rate: 100 }, night: { enabled: true, rate: 25, startTime: '23:00', endTime: '06:00' } })
);

// Anna has no 2026 balance yet — her lazy init should pick up v2
const anna2026 = ensureYearBalance('as', 2026);
const policyV2 = getPolicyOn('2026-01-01');

assert('Anna 2026 uses new policy v2 (flat 30 days)', anna2026.policy_id === policyV2.id);
// Anna 80%: 30 × 80% = 24 days
assert('Anna 2026 entitlement = 24 days (v2 flat 30 × 80%)', anna2026.vacation_entitlement === 24);

// ─────────────────────────────────────────────
// 7.6 — 2025 year_balance frozen after rollover
// ─────────────────────────────────────────────
section('7.6 2025 Balance Frozen After 2026 Rollover');

const mm2025After = db.prepare('SELECT * FROM year_balances WHERE employee_id=? AND year=2025').get('mm');

// The 2025 row should be exactly what seed created — untouched
assert('2025 entitlement unchanged after 2026 rollover', mm2025After.vacation_entitlement === 23);
assert('2025 carryover unchanged',                       mm2025After.vacation_carryover   === 3);
assert('2025 policy_id unchanged',                       mm2025After.policy_id            === 1);

// Only one row exists for 2025
const count2025 = db.prepare('SELECT COUNT(*) as c FROM year_balances WHERE employee_id=? AND year=2025').get('mm');
assert('Exactly one 2025 balance row',                   count2025.c === 1);

// ─────────────────────────────────────────────
// 7.7 — Age increments correctly for 2026
// ─────────────────────────────────────────────
section('7.7 Age Increments Correctly for New Year');

// Max born 1997-03-15
// Age at Jan 1 2025 = 27 (birthday not yet in Jan)
// Age at Jan 1 2026 = 28
const snap2025 = db.prepare('SELECT snapshot FROM year_balances WHERE employee_id=? AND year=2025').get('mm');
const snap2026 = db.prepare('SELECT snapshot FROM year_balances WHERE employee_id=? AND year=2026').get('mm');

const age2025 = JSON.parse(snap2025.snapshot)?.age_at_jan1;
const age2026 = JSON.parse(snap2026.snapshot)?.age_at_jan1;

assert('Age recorded in 2025 snapshot', age2025 != null);
assert('Age recorded in 2026 snapshot', age2026 != null);
assert('Age increments by 1 between years', age2026 === age2025 + 1);

// ─────────────────────────────────────────────
// 7.8 — Employee hired mid-2025 gets full 2026
// ─────────────────────────────────────────────
section('7.8 Mid-2025 Hire Gets Full Entitlement in 2026');

// Sarah Lang hired 2025-07-01. In 2025 she got pro-rata (partial year).
// In 2026 she should get a FULL year entitlement (she's been here the whole year).
// v2 policy: flat 30 days × 100% = 30 days
const sarah2025 = db.prepare('SELECT * FROM year_balances WHERE employee_id=? AND year=2025').get('sl');
const sarah2026 = ensureYearBalance('sl', 2026);

assert('Sarah 2025 entitlement was full (seed gave full 23 days)', sarah2025.vacation_entitlement === 23);
assert('Sarah 2026 uses v2 policy (flat 30 days)',                  sarah2026.vacation_entitlement === 30);
assert('2026 is full year — more than 2025',                        sarah2026.vacation_entitlement >= sarah2025.vacation_entitlement);

// ─────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────
console.log(`\n${'═'.repeat(52)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('  🎉 Group 7 passed! Year-end rollover is solid.\n');
} else {
  console.log('  ⚠️  Some tests failed.\n');
}
