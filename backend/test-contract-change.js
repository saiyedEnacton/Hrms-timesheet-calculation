/**
 * GROUP 3 — Employee Contract Change Mid-Year
 *
 * Scenario:
 *   Anna Schmidt is 80% part-time from 2025-01-01
 *   On 2025-06-01 she drops to 60%
 *
 * What we prove:
 *   - Old contract is closed, new contract is active from change date
 *   - Time entries before June: OT threshold was 32h/week (40 × 80%)
 *   - Time entries after June: OT threshold is 24h/week (40 × 60%)
 *   - 2025 year_balance is unchanged (vacation entitlement stays at 18.4 days)
 *   - 2026 lazy init picks up 60%, entitlement recalculates
 *   - Point-in-time contract lookup returns correct version for any date
 */

import db from './db.js';

// ─────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────
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

function round1(n) {
  return Math.round(n * 10) / 10;
}

function getPolicyOn(date) {
  return db.prepare(`
    SELECT * FROM company_policies
    WHERE effective_from <= ?
      AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY effective_from DESC LIMIT 1
  `).get(date, date);
}

function getContractOn(employeeId, date) {
  return db.prepare(`
    SELECT * FROM employment_contracts
    WHERE employee_id = ?
      AND effective_from <= ?
      AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY effective_from DESC LIMIT 1
  `).get(employeeId, date, date);
}

function logWorkEntry(employeeId, date, clockIn, clockOut, breakMin) {
  const policy   = getPolicyOn(date);
  const contract = getContractOn(employeeId, date);
  const premiums = JSON.parse(policy.premium_rates);

  const clockInH  = parseInt(clockIn.split(':')[0])  + parseInt(clockIn.split(':')[1])  / 60;
  const clockOutH = parseInt(clockOut.split(':')[0]) + parseInt(clockOut.split(':')[1]) / 60;
  const gross     = round1(clockOutH - clockInH - breakMin / 60);

  // Overtime threshold = weekly target / 5 days  (daily equivalent)
  const dailyTarget = contract.weekly_target_hours / 5;
  const regular  = round1(Math.min(gross, dailyTarget));
  const overtime = round1(Math.max(0, gross - dailyTarget));

  db.prepare(`
    INSERT OR IGNORE INTO time_entries (
      employee_id, work_date, entry_type,
      clock_in, clock_out, break_minutes,
      hours, regular_hours, overtime_hours,
      policy_id, source, status
    ) VALUES (?, ?, 'work', ?, ?, ?, ?, ?, ?, ?, 'timesheet', 'approved')
  `).run(
    employeeId, date, clockIn, clockOut, breakMin,
    gross, regular, overtime,
    policy.id
  );
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

  let entitlement;
  if (policy.age_based_vacation) {
    const ranges = JSON.parse(policy.age_ranges);
    const range  = ranges.find(r => age >= r.minAge && (r.maxAge === null || age <= r.maxAge));
    entitlement  = round1((range ? range.days : policy.default_vacation_days) * (contract.work_percentage / 100));
  } else {
    entitlement = round1(policy.default_vacation_days * (contract.work_percentage / 100));
  }

  const prevBalance = db.prepare(
    'SELECT * FROM year_balances WHERE employee_id = ? AND year = ?'
  ).get(employeeId, year - 1);

  let vacCarryover = 0;
  let otCarryover  = 0;

  if (prevBalance) {
    const vacUsed = db.prepare(`
      SELECT COALESCE(SUM(hours) / 8.0, 0) as days
      FROM time_entries
      WHERE employee_id = ? AND entry_type = 'vacation'
        AND strftime('%Y', work_date) = ?
    `).get(employeeId, String(year - 1))?.days || 0;

    const unused = round1(prevBalance.vacation_entitlement + prevBalance.vacation_carryover - vacUsed);
    vacCarryover = Math.min(Math.max(unused, 0), policy.max_carryover_days);

    const otHours = db.prepare(`
      SELECT COALESCE(SUM(overtime_hours), 0) as hours
      FROM time_entries
      WHERE employee_id = ? AND strftime('%Y', work_date) = ?
    `).get(employeeId, String(year - 1))?.hours || 0;

    otCarryover = round1(prevBalance.overtime_carryover + otHours);
  }

  db.prepare(`
    INSERT INTO year_balances
      (employee_id, year, vacation_entitlement, vacation_carryover, overtime_carryover, policy_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    employeeId, year, entitlement, vacCarryover, otCarryover, policy.id
  );

  return db.prepare(
    'SELECT * FROM year_balances WHERE employee_id = ? AND year = ?'
  ).get(employeeId, year);
}

// ─────────────────────────────────────────────
// SETUP — Change Anna's contract 80% → 60%
// ─────────────────────────────────────────────
section('Setup — Anna changes from 80% to 60% on 2025-06-01');

// Close old 80% contract
db.prepare(`
  UPDATE employment_contracts
  SET effective_to = '2025-05-31'
  WHERE employee_id = 'as' AND effective_to IS NULL
`).run();

// Open new 60% contract
db.prepare(`
  INSERT INTO employment_contracts
    (employee_id, employment_type, work_percentage, weekly_target_hours, effective_from)
  VALUES ('as', 'part-time', 60, 24, '2025-06-01')
`).run();

const contractBefore = getContractOn('as', '2025-05-15');
const contractAfter  = getContractOn('as', '2025-06-15');

assert('Contract on 2025-05-15 = 80%', contractBefore?.work_percentage === 80);
assert('Contract on 2025-06-15 = 60%', contractAfter?.work_percentage  === 60);
assert('Only one contract has effective_to = NULL', (() => {
  const r = db.prepare(`SELECT COUNT(*) as c FROM employment_contracts WHERE employee_id = 'as' AND effective_to IS NULL`).get();
  return r.c === 1;
})());
assert('Old 80% contract closed on 2025-05-31', contractBefore?.effective_to === '2025-05-31');
assert('New 60% contract weekly target = 24h', contractAfter?.weekly_target_hours === 24);

// ─────────────────────────────────────────────
// TEST 3.3 — Old entries (before change) use 80% snapshot
// ─────────────────────────────────────────────
section('Old Entries Reflect 80% Contract');

// Anna's seed entries are in March 2025 (under 80% contract)
// 8h day, daily target at 80% = 32h/week ÷ 5 = 6.4h/day → 1.6h OT per day
const marchEntry = db.prepare(`
  SELECT * FROM time_entries
  WHERE employee_id = 'as' AND work_date = '2025-03-03'
`).get();

assert('Anna March entry exists (from seed)', marchEntry != null);
assert('March entry references policy v1', marchEntry?.policy_id === 1);
assert('March entry hours = 8', marchEntry?.hours === 8);

// ─────────────────────────────────────────────
// TEST 3.4 — New entries (after change) snapshot captures 60%
// ─────────────────────────────────────────────
section('New Entries Reflect 60% Contract');

// Add entries in June (under new 60% contract)
// Daily target at 60% = 24h/week ÷ 5 = 4.8h/day
// 8h work day → regular = 4.8h, overtime = 3.2h
logWorkEntry('as', '2025-06-02', '09:00', '17:30', 30);  // 8h gross
logWorkEntry('as', '2025-06-03', '09:00', '17:30', 30);
logWorkEntry('as', '2025-06-04', '09:00', '17:30', 30);

const juneEntry = db.prepare(`
  SELECT * FROM time_entries
  WHERE employee_id = 'as' AND work_date = '2025-06-02'
`).get();

assert('Anna June entry exists', juneEntry != null);

// 8h gross - 4.8h daily target = 3.2h OT
assert('June OT = 3.2h (60% threshold applied)', juneEntry?.overtime_hours === 3.2);
assert('June regular = 4.8h',                    juneEntry?.regular_hours  === 4.8);

// ─────────────────────────────────────────────
// TEST 3.5 — Same hours logged, different OT result
// ─────────────────────────────────────────────
section('Same Hours, Different OT Due to Contract Change');

// Under 80%: daily target = 6.4h → 8h gives 1.6h OT
// Under 60%: daily target = 4.8h → 8h gives 3.2h OT
// We'll add a comparable March entry to make the diff clear
logWorkEntry('as', '2025-03-20', '09:00', '17:30', 30);  // 8h, 80% contract

const march20 = db.prepare(`SELECT * FROM time_entries WHERE employee_id = 'as' AND work_date = '2025-03-20'`).get();

assert('March 20 OT = 1.6h (80% threshold)',   march20?.overtime_hours    === 1.6);
assert('June 2 OT = 3.2h (60% threshold)',     juneEntry?.overtime_hours  === 3.2);
assert('Same gross hours (8h), different OT',  march20?.hours === juneEntry?.hours && march20?.overtime_hours !== juneEntry?.overtime_hours);

// ─────────────────────────────────────────────
// TEST 3.6 — 2025 year_balance unchanged
// ─────────────────────────────────────────────
section('2025 Year Balance Unchanged After Contract Switch');

const anna2025 = db.prepare(
  'SELECT * FROM year_balances WHERE employee_id = ? AND year = 2025'
).get('as');

// Set in seed: 23 days × 80% = 18.4 days
assert('Anna 2025 entitlement still 18.4 days (80% at year start)', anna2025?.vacation_entitlement === 18.4);
assert('Anna 2025 balance policy still v1', anna2025?.policy_id === 1);

// ─────────────────────────────────────────────
// TEST 3.7 — 2026 lazy init uses 60% contract
// ─────────────────────────────────────────────
section('2026 Year Balance — Lazy Init Uses 60% Contract');

const before2026 = db.prepare(
  'SELECT * FROM year_balances WHERE employee_id = ? AND year = 2026'
).get('as');
assert('No 2026 balance before lazy init', before2026 == null);

const anna2026 = ensureYearBalance('as', 2026);

// Jan 1 2026: Anna is on 60% contract. Age 36. Range 20-49 = 23 days × 60% = 13.8 days
assert('2026 balance created',                        anna2026 != null);
assert('2026 entitlement = 13.8 days (23 × 60%)',    anna2026?.vacation_entitlement === 13.8);


// ─────────────────────────────────────────────
// TEST 3.8 — Point-in-time contract lookup
// ─────────────────────────────────────────────
section('Point-in-Time Contract Queries');

const checks = [
  ['2025-01-01', 80],
  ['2025-05-31', 80],
  ['2025-06-01', 60],
  ['2025-12-31', 60],
  ['2026-03-01', 60],
];

for (const [date, expectedPct] of checks) {
  const c = getContractOn('as', date);
  assert(`Anna contract on ${date} = ${expectedPct}%`, c?.work_percentage === expectedPct);
}

// ─────────────────────────────────────────────
// TEST 3.9 — Vacation carryover into 2026 uses 5-day cap
// ─────────────────────────────────────────────
section('Vacation Carryover 2025 → 2026');

// Anna 2025: entitlement=18.4, carryover=0, used=1 sick (doesn't count) + 0 vacation from seed
// So unused vacation = 18.4 + 0 - 0 = 18.4, capped at 5
assert('Anna 2026 vacation carryover capped at 5 days', anna2026?.vacation_carryover === 5);

// OT from 2025: 3 June entries × 3.2h = 9.6h + March 20 entry × 1.6h = 11.2h
// Plus seed entries for Anna (8 entries, 0 OT each since seed used full hours as regular)
const expectedOT = round1(
  0 +                // no 2025 OT carryover for Anna
  (3 * 3.2) +        // 3 June entries
  1.6                // March 20 entry
);
assert(`Anna 2026 OT carryover = ${expectedOT}h`, anna2026?.overtime_carryover === expectedOT);

// ─────────────────────────────────────────────
// TEST 3.10 — No orphaned contracts
// ─────────────────────────────────────────────
section('Data Integrity');

const openContracts = db.prepare(`
  SELECT employee_id, COUNT(*) as c
  FROM employment_contracts
  WHERE effective_to IS NULL
  GROUP BY employee_id
  HAVING c > 1
`).all();
assert('No employee has more than 1 open contract', openContracts.length === 0);

const noContract = db.prepare(`
  SELECT te.employee_id, te.work_date
  FROM time_entries te
  WHERE te.entry_type = 'work'
    AND NOT EXISTS (
      SELECT 1 FROM employment_contracts ec
      WHERE ec.employee_id = te.employee_id
        AND ec.effective_from <= te.work_date
        AND (ec.effective_to IS NULL OR ec.effective_to >= te.work_date)
    )
`).all();
assert('Every work entry has a matching contract on that date', noContract.length === 0);

// ─────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────
console.log(`\n${'═'.repeat(52)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('  🎉 Group 3 passed! Contract versioning is solid.\n');
} else {
  console.log('  ⚠️  Some tests failed.\n');
}
