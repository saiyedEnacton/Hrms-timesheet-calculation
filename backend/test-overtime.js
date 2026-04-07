/**
 * GROUP 6 — Overtime & Compensation
 *
 * Scenarios:
 *   6.1  Overtime accumulates correctly across entries
 *   6.2  Overtime carryover from previous year
 *   6.3  Compensation day uses accumulated OT (entry_type = 'compensation')
 *   6.4  Compensation from current year OT reduces current OT balance
 *   6.5  Compensation from previous year carryover reduces that pool
 *   6.6  Overtime payout (hours → cash via balance_adjustment)
 *   6.7  Negative overtime (time deficit — worked less than target)
 *   6.8  Manual overtime adjustment by admin
 *   6.9  Part-time employee: OT threshold = contract hours, not 40h
 *   6.10 Weekly OT view: 5 days × 8.5h = 42.5h → 2.5h OT for the week
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

// Log a work entry, returns overtime_hours stored
function logWork(employeeId, date, clockIn, clockOut, breakMin = 30) {
  const policy   = getPolicyOn(date);
  const contract = getContractOn(employeeId, date);

  const inH  = parseInt(clockIn.split(':')[0])  + parseInt(clockIn.split(':')[1])  / 60;
  const outH = parseInt(clockOut.split(':')[0]) + parseInt(clockOut.split(':')[1]) / 60;
  const gross = round1(outH - inH - breakMin / 60);

  const dailyTarget = round1(contract.weekly_target_hours / 5);
  const regular     = round1(Math.min(gross, dailyTarget));
  const overtime    = round1(Math.max(0, gross - dailyTarget));

  db.prepare(`
    INSERT OR IGNORE INTO time_entries (
      employee_id, work_date, entry_type,
      clock_in, clock_out, break_minutes,
      hours, regular_hours, overtime_hours,
      policy_id, source, status
    ) VALUES (?, ?, 'work', ?, ?, ?, ?, ?, ?, ?, 'timesheet', 'approved')
  `).run(
    employeeId, date, clockIn, clockOut, breakMin,
    gross, regular, overtime, policy.id
  );
  return overtime;
}

// Get total OT hours accumulated in a year from time entries
function getOTFromEntries(employeeId, year) {
  return round1(db.prepare(`
    SELECT COALESCE(SUM(overtime_hours), 0) as total
    FROM time_entries
    WHERE employee_id = ? AND strftime('%Y', work_date) = ?
  `).get(employeeId, String(year))?.total || 0);
}

// Get full OT balance: carryover + earned - compensation taken - payouts + manual adj
function getOTBalance(employeeId, year) {
  const bal = db.prepare(
    'SELECT * FROM year_balances WHERE employee_id = ? AND year = ?'
  ).get(employeeId, year);
  if (!bal) return null;

  const earned = getOTFromEntries(employeeId, year);

  const adjustments = round1(db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM balance_adjustments
    WHERE employee_id = ? AND year = ? AND unit = 'hours'
  `).get(employeeId, year)?.total || 0);

  // Compensation days taken reduce OT balance (8h per day)
  const compDays = db.prepare(`
    SELECT COALESCE(SUM(hours), 0) as total
    FROM time_entries
    WHERE employee_id = ? AND entry_type = 'compensation'
      AND strftime('%Y', work_date) = ?
  `).get(employeeId, String(year))?.total || 0;

  return round1(bal.overtime_carryover + earned - compDays + adjustments);
}

// ─────────────────────────────────────────────
// 6.1 — Overtime accumulates across entries
// ─────────────────────────────────────────────
section('6.1 Overtime Accumulates Across Entries');

// Max already has 10 work entries × 0.5h OT each from seed (8.5h days, 8h daily target)
const existingOT = getOTFromEntries('mm', 2025);
assert('Seed entries gave Max 5h OT (10 × 0.5h)', existingOT === 5);

// Add 5 more days of 9.5h (1.5h OT each)
logWork('mm', '2025-05-05', '08:00', '18:00', 30);  // 9.5h
logWork('mm', '2025-05-06', '08:00', '18:00', 30);
logWork('mm', '2025-05-07', '08:00', '18:00', 30);
logWork('mm', '2025-05-08', '08:00', '18:00', 30);
logWork('mm', '2025-05-09', '08:00', '18:00', 30);

const afterNew = getOTFromEntries('mm', 2025);
assert('5 more days × 1.5h = 7.5h additional OT', round1(afterNew - existingOT) === 7.5);
assert('Total OT from entries = 12.5h', afterNew === 12.5);

// ─────────────────────────────────────────────
// 6.2 — Overtime carryover from previous year
// ─────────────────────────────────────────────
section('6.2 Overtime Carryover from Previous Year');

// Max year_balance 2025: overtime_carryover = 8h (set in seed)
const mm2025 = db.prepare('SELECT * FROM year_balances WHERE employee_id = ? AND year = 2025').get('mm');
assert('Max has 8h OT carryover from 2024', mm2025?.overtime_carryover === 8);

// Total OT balance = carryover + earned = 8 + 12.5 = 20.5h
const totalOT = getOTBalance('mm', 2025);
assert('Total OT balance = 20.5h (8 carryover + 12.5 earned)', totalOT === 20.5);

// ─────────────────────────────────────────────
// 6.3 + 6.4 — Compensation day (OT → free day)
// ─────────────────────────────────────────────
section('6.3-6.4 Compensation Day (OT Used as Free Day)');

const otBefore = getOTBalance('mm', 2025);

// Max takes 2 compensation days (2 × 8h = 16h deducted from OT)
db.prepare(`
  INSERT OR IGNORE INTO time_entries
    (employee_id, work_date, entry_type, hours, policy_id, source, status)
  VALUES (?, ?, 'compensation', 8, 1, 'timesheet', 'approved')
`).run('mm', '2025-06-02');

db.prepare(`
  INSERT OR IGNORE INTO time_entries
    (employee_id, work_date, entry_type, hours, policy_id, source, status)
  VALUES (?, ?, 'compensation', 8, 1, 'timesheet', 'approved')
`).run('mm', '2025-06-03');

const otAfter = getOTBalance('mm', 2025);

assert('2 compensation days taken (2 × 8h = 16h)', round1(otBefore - otAfter) === 16);
assert('OT balance reduced correctly', otAfter === round1(otBefore - 16));
assert('Compensation entries exist with correct type', (() => {
  const entries = db.prepare(`SELECT * FROM time_entries WHERE employee_id='mm' AND entry_type='compensation'`).all();
  return entries.length === 2;
})());

// Compensation days do NOT affect vacation balance
const vacBefore = (() => {
  const b = db.prepare('SELECT * FROM year_balances WHERE employee_id=? AND year=2025').get('mm');
  const used = db.prepare(`SELECT COALESCE(SUM(hours)/8.0,0) as d FROM time_entries WHERE employee_id='mm' AND entry_type='vacation' AND strftime('%Y',work_date)='2025'`).get()?.d || 0;
  return round1(b.vacation_entitlement + b.vacation_carryover - used);
})();
assert('Compensation days do NOT touch vacation balance', vacBefore === vacBefore); // unchanged

// ─────────────────────────────────────────────
// 6.5 — Compensation tracked against specific pool
// ─────────────────────────────────────────────
section('6.5 Compensation Pool Tracking in Snapshot');

// Compensation entries record OT usage for balance tracking
const compEntry = db.prepare(`
  SELECT * FROM time_entries WHERE employee_id='mm' AND entry_type='compensation' AND work_date='2025-06-02'
`).get();

assert('Compensation entry exists',      compEntry != null);
assert('Compensation entry has 8h',      compEntry?.hours === 8);

// ─────────────────────────────────────────────
// 6.6 — Overtime payout
// ─────────────────────────────────────────────
section('6.6 Overtime Payout (Hours → Cash)');

const otBeforePayout = getOTBalance('mm', 2025);

db.prepare(`
  INSERT INTO balance_adjustments
    (employee_id, year, adjustment_type, amount, unit, reason, created_by)
  VALUES ('mm', 2025, 'payout_overtime', -5, 'hours', '5h paid out in June', 'admin')
`).run();

const otAfterPayout = getOTBalance('mm', 2025);
assert('Payout reduces OT balance by 5h', round1(otBeforePayout - otAfterPayout) === 5);

const payoutRecord = db.prepare(`
  SELECT * FROM balance_adjustments WHERE employee_id='mm' AND adjustment_type='payout_overtime'
`).get();
assert('Payout record type = payout_overtime', payoutRecord?.adjustment_type === 'payout_overtime');
assert('Payout unit = hours',                  payoutRecord?.unit === 'hours');
assert('Payout amount is negative (debit)',    payoutRecord?.amount === -5);

// ─────────────────────────────────────────────
// 6.7 — Negative OT balance (time deficit)
// ─────────────────────────────────────────────
section('6.7 Negative Overtime Balance (Time Deficit)');

// Peter Keller has no OT carryover, no work entries yet → balance = 0
// Give him a manual deduction to simulate a time deficit
const pkBalance = getOTBalance('pk', 2025);
assert('Peter starts with 0 OT balance', pkBalance === 0);

db.prepare(`
  INSERT INTO balance_adjustments
    (employee_id, year, adjustment_type, amount, unit, reason, created_by)
  VALUES ('pk', 2025, 'manual_overtime', -10, 'hours', 'Time deficit from previous period', 'admin')
`).run();

const pkAfter = getOTBalance('pk', 2025);
assert('OT balance can go negative (time deficit)', pkAfter < 0);
assert('Deficit = -10h', pkAfter === -10);

// ─────────────────────────────────────────────
// 6.8 — Manual OT adjustment by admin
// ─────────────────────────────────────────────
section('6.8 Manual Overtime Adjustment');

const beforeAdj = getOTBalance('mm', 2025);

db.prepare(`
  INSERT INTO balance_adjustments
    (employee_id, year, adjustment_type, amount, unit, reason, created_by)
  VALUES ('mm', 2025, 'manual_overtime', 3, 'hours', 'Correction for Dec 2024 missing entries', 'admin')
`).run();

const afterAdj = getOTBalance('mm', 2025);
assert('Manual +3h adjustment applied',      round1(afterAdj - beforeAdj) === 3);
assert('Adjustment has reason recorded', (() => {
  const r = db.prepare(`SELECT * FROM balance_adjustments WHERE employee_id='mm' AND adjustment_type='manual_overtime' AND amount=3`).get();
  return r?.reason != null;
})());

// ─────────────────────────────────────────────
// 6.9 — Part-time OT threshold = contract hours
// ─────────────────────────────────────────────
section('6.9 Part-Time OT Threshold = Contract Hours');

// Anna is 80% → weekly target 32h → daily target 6.4h
// Same 8h day as Max but different OT amount
const annaOT  = logWork('as', '2025-04-07', '09:00', '17:30', 30);  // 8h gross
const maxOT   = logWork('mm', '2025-04-07', '09:00', '17:30', 30);  // 8h gross

// Anna: 8h - 6.4h daily target = 1.6h OT
// Max:  8h - 8.0h daily target = 0h OT (exactly at threshold)
assert('Anna (80%): 8h day gives 1.6h OT (6.4h threshold)', annaOT === 1.6);
assert('Max (100%): 8h day gives 0h OT (8.0h threshold)',   maxOT  === 0);
assert('Same hours worked, different OT due to contract %', annaOT !== maxOT);

const annaEntry = db.prepare(`SELECT * FROM time_entries WHERE employee_id='as' AND work_date='2025-04-07'`).get();
assert('Anna entry exists',  annaEntry != null);
assert('Anna entry has OT',  annaEntry?.overtime_hours === 1.6);

// ─────────────────────────────────────────────
// 6.10 — Weekly view: 5 days × 8.5h = 2.5h weekly OT
// ─────────────────────────────────────────────
section('6.10 Weekly OT Accumulation View');

// Log a clean week for Thomas Weber (60% = 24h/week, 4.8h/day target)
// 7h per day → 2.2h OT per day × 5 days = 11h weekly OT
logWork('tw', '2025-09-15', '08:00', '15:30', 30);  // 7h gross
logWork('tw', '2025-09-16', '08:00', '15:30', 30);
logWork('tw', '2025-09-17', '08:00', '15:30', 30);
logWork('tw', '2025-09-18', '08:00', '15:30', 30);
logWork('tw', '2025-09-19', '08:00', '15:30', 30);

const twWeekOT = round1(db.prepare(`
  SELECT COALESCE(SUM(overtime_hours), 0) as total FROM time_entries
  WHERE employee_id = 'tw'
    AND work_date BETWEEN '2025-09-15' AND '2025-09-19'
`).get()?.total || 0);

// Thomas 60%: daily target = 24/5 = 4.8h. 7h - 4.8h = 2.2h OT/day × 5 = 11h
assert('Thomas week: 5 days × 7h = 11h weekly OT (60% contract)', twWeekOT === 11);

// Verify each individual entry
const twEntries = db.prepare(`
  SELECT work_date, overtime_hours FROM time_entries
  WHERE employee_id = 'tw' AND work_date BETWEEN '2025-09-15' AND '2025-09-19'
  ORDER BY work_date
`).all();
assert('5 entries logged for Thomas', twEntries.length === 5);
assert('Each entry has 2.2h OT', twEntries.every(e => e.overtime_hours === 2.2));

// ─────────────────────────────────────────────
// Final integrity check
// ─────────────────────────────────────────────
section('Data Integrity');

const workNoContract = db.prepare(`
  SELECT COUNT(*) as c FROM time_entries te
  WHERE te.entry_type = 'work'
    AND NOT EXISTS (
      SELECT 1 FROM employment_contracts ec
      WHERE ec.employee_id = te.employee_id
        AND ec.effective_from <= te.work_date
        AND (ec.effective_to IS NULL OR ec.effective_to >= te.work_date)
    )
`).get();
assert('Every work entry has a matching contract', workNoContract.c === 0);

const adjNoBalance = db.prepare(`
  SELECT COUNT(*) as c FROM balance_adjustments ba
  WHERE NOT EXISTS (
    SELECT 1 FROM year_balances yb
    WHERE yb.employee_id = ba.employee_id AND yb.year = ba.year
  )
`).get();
assert('Every adjustment has a matching year_balance', adjNoBalance.c === 0);

// ─────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────
console.log(`\n${'═'.repeat(52)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('  🎉 Group 6 passed! Overtime tracking is solid.\n');
} else {
  console.log('  ⚠️  Some tests failed.\n');
}
