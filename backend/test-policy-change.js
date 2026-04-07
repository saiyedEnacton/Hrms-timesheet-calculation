/**
 * GROUP 2 — Policy Change Mid-Year
 *
 * Scenario:
 *   - Policy v1 active from 2025-01-01 (weekly OT threshold: 40h, age-based vacation)
 *   - Policy v2 effective 2025-07-01 (weekly OT threshold: 35h, flat 28 days vacation)
 *
 * What we prove:
 *   - Old time entries (March 2025) are frozen with v1 snapshot — untouched
 *   - New time entries (August 2025) use v2 rules
 *   - Current year_balances are NOT changed by the policy switch
 *   - 2026 year_balance (lazy init) picks up v2 rules correctly
 *   - Point-in-time policy resolution always returns the right version
 */

import db from './db.js';

// ─────────────────────────────────────────────
// Helpers
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

// Get the policy active on a given date
function getPolicyOn(date) {
  return db.prepare(`
    SELECT * FROM company_policies
    WHERE effective_from <= ?
      AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY effective_from DESC LIMIT 1
  `).get(date, date);
}

// Get contract active on a given date
function getContractOn(employeeId, date) {
  return db.prepare(`
    SELECT * FROM employment_contracts
    WHERE employee_id = ?
      AND effective_from <= ?
      AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY effective_from DESC LIMIT 1
  `).get(employeeId, date, date);
}

// Lazy init year balance (the core mechanism)
function ensureYearBalance(employeeId, year) {
  const exists = db.prepare(
    'SELECT * FROM year_balances WHERE employee_id = ? AND year = ?'
  ).get(employeeId, year);

  if (exists) return exists;

  const jan1 = `${year}-01-01`;
  const policy = getPolicyOn(jan1);
  const contract = getContractOn(employeeId, jan1);
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);

  // Calculate age at Jan 1 of this year
  const dob = new Date(employee.date_of_birth);
  const refDate = new Date(jan1);
  let age = refDate.getFullYear() - dob.getFullYear();
  const m = refDate.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && refDate.getDate() < dob.getDate())) age--;

  // Get vacation entitlement from policy
  let entitlement;
  if (policy.age_based_vacation) {
    const ranges = JSON.parse(policy.age_ranges);
    const range = ranges.find(r => age >= r.minAge && (r.maxAge === null || age <= r.maxAge));
    entitlement = round1((range ? range.days : policy.default_vacation_days) * (contract.work_percentage / 100));
  } else {
    entitlement = round1(policy.default_vacation_days * (contract.work_percentage / 100));
  }

  // Pull previous year balance for carryover
  const prevBalance = db.prepare(
    'SELECT * FROM year_balances WHERE employee_id = ? AND year = ?'
  ).get(employeeId, year - 1);

  let vacCarryover = 0;
  let otCarryover = 0;

  if (prevBalance) {
    // Calculate unused vacation from prev year
    const vacUsed = db.prepare(`
      SELECT COALESCE(SUM(hours) / 8.0, 0) as days
      FROM time_entries
      WHERE employee_id = ? AND entry_type = 'vacation'
        AND strftime('%Y', work_date) = ?
    `).get(employeeId, String(year - 1))?.days || 0;

    const adjustments = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM balance_adjustments
      WHERE employee_id = ? AND year = ? AND unit = 'days'
    `).get(employeeId, year - 1)?.total || 0;

    const unused = round1(prevBalance.vacation_entitlement + prevBalance.vacation_carryover - vacUsed + adjustments);
    vacCarryover = Math.min(Math.max(unused, 0), policy.max_carryover_days);

    // Overtime carryover: all remaining OT hours carry over (no cap)
    const otHours = db.prepare(`
      SELECT COALESCE(SUM(overtime_hours + extratime_hours), 0) as hours
      FROM time_entries
      WHERE employee_id = ? AND strftime('%Y', work_date) = ?
    `).get(employeeId, String(year - 1))?.hours || 0;

    const otAdjust = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM balance_adjustments
      WHERE employee_id = ? AND year = ? AND unit = 'hours'
    `).get(employeeId, year - 1)?.total || 0;

    otCarryover = round1(prevBalance.overtime_carryover + otHours + otAdjust);
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

// Add a time entry with correct policy snapshot
function logWorkEntry(employeeId, date, clockIn, clockOut, breakMin) {
  const policy = getPolicyOn(date);
  const premiums = JSON.parse(policy.premium_rates);
  const gross = (
    (parseInt(clockOut) - parseInt(clockIn)) - (breakMin / 60)
  );
  // Simple daily calc — overtime beyond daily_hours
  const regular = Math.min(gross, policy.daily_hours);
  const overtime = Math.max(0, round1(gross - policy.daily_hours));

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

// ─────────────────────────────────────────────
// SETUP: Close policy v1, insert policy v2
// ─────────────────────────────────────────────

section('Setup — Create Policy v2 (effective 2025-07-01)');

// Close policy v1
db.prepare(`UPDATE company_policies SET effective_to = '2025-06-30' WHERE effective_to IS NULL`).run();

// Insert policy v2: OT threshold drops to 35h/week, vacation flat 28 days
const v2 = db.prepare(`
  INSERT INTO company_policies (
    version, weekly_hours, max_weekly_hours, daily_hours,
    age_based_vacation, default_vacation_days, age_ranges,
    carryover_allowed, max_carryover_days,
    premium_rates, effective_from, change_reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  2, 35, 45, 7,
  0, 28,                              // flat vacation, 28 days for everyone
  JSON.stringify([
    { minAge: 18, maxAge: 19, days: 28 },
    { minAge: 20, maxAge: 49, days: 28 },
    { minAge: 50, maxAge: null, days: 28 }
  ]),
  1, 5,
  JSON.stringify({
    overtime:  { enabled: true, rate: 0,   threshold: 35 },  // lower threshold
    extratime: { enabled: true, rate: 25,  threshold: 45 },
    holiday:   { enabled: true, rate: 100 },
    sunday:    { enabled: true, rate: 100 },
    night:     { enabled: true, rate: 25, startTime: '23:00', endTime: '06:00' }
  }),
  '2025-07-01',
  'Overtime threshold lowered to 35h. Vacation switched to flat 28 days.'
);

const policyV1 = getPolicyOn('2025-03-01');
const policyV2 = getPolicyOn('2025-08-01');

assert('Policy v1 is active on 2025-03-01', policyV1?.version === 1);
assert('Policy v2 is active on 2025-08-01', policyV2?.version === 2);
assert('Policy v2 has weekly_hours = 35', policyV2?.weekly_hours === 35);
assert('Policy v2 has flat vacation (age_based = 0)', policyV2?.age_based_vacation === 0);
assert('Only one policy has effective_to = NULL', (() => {
  const active = db.prepare(`SELECT COUNT(*) as c FROM company_policies WHERE effective_to IS NULL`).get();
  return active.c === 1;
})());

// ─────────────────────────────────────────────
// TEST 2.2 — Old entries still reference v1
// ─────────────────────────────────────────────
section('Old Entries Frozen with Policy v1');

// Max already has March 2025 entries from seed
const marchEntry = db.prepare(`
  SELECT te.*, cp.version as policy_version
  FROM time_entries te
  JOIN company_policies cp ON te.policy_id = cp.id
  WHERE te.employee_id = 'mm' AND te.work_date = '2025-03-03'
`).get();

assert('March entry exists', marchEntry != null);
assert('March entry references policy v1', marchEntry?.policy_id === policyV1?.id);

// ─────────────────────────────────────────────
// TEST 2.3 — New entries use policy v2
// ─────────────────────────────────────────────
section('New Entries Use Policy v2');

logWorkEntry('mm', '2025-08-04', '08:00', '16:00', 30); // 7.5h (under v2 daily=7, so 0.5h OT)
logWorkEntry('mm', '2025-08-05', '08:00', '16:00', 30);

const augEntry = db.prepare(`
  SELECT te.*, cp.version as policy_version
  FROM time_entries te
  JOIN company_policies cp ON te.policy_id = cp.id
  WHERE te.employee_id = 'mm' AND te.work_date = '2025-08-04'
`).get();

assert('August entry exists', augEntry != null);
assert('August entry references policy v2', augEntry?.policy_version === 2);


// ─────────────────────────────────────────────
// TEST 2.4 — Old entry overtime unchanged
// ─────────────────────────────────────────────
section('Historical Overtime Accuracy');

// Under v1: daily threshold was 8h. March entry was 8.5h → 0.5h OT
assert('March entry: 0.5h overtime (v1 rule: >8h daily)', marchEntry?.overtime_hours === 0.5);

// Under v2: daily threshold is 7h. August entry 7.5h → 0.5h OT
assert('August entry: 0.5h overtime (v2 rule: >7h daily)', augEntry?.overtime_hours === 0.5);

// Now verify: if v1 rule were applied to August, OT would be 0 (7.5 < 8)
// But it correctly stored 0.5 because v2 (7h threshold) was used
assert('Aug OT is NOT 0 — v2 lower threshold was applied, not v1', augEntry?.overtime_hours !== 0);

// ─────────────────────────────────────────────
// TEST 2.5 — Current year vacation NOT changed
// ─────────────────────────────────────────────
section('2025 Vacation Entitlement Unchanged After Policy Switch');

// Max's 2025 year_balance was set in seed with v1 (age-based: age 28 = 23 days)
const mmBalance2025 = db.prepare(
  'SELECT * FROM year_balances WHERE employee_id = ? AND year = 2025'
).get('mm');

assert('Max 2025 entitlement still 23 days (v1 age-based)', mmBalance2025?.vacation_entitlement === 23);
assert('Max 2025 balance still references policy v1', mmBalance2025?.policy_id === policyV1?.id);

// ─────────────────────────────────────────────
// TEST 2.6 — 2026 lazy init picks up v2
// ─────────────────────────────────────────────
section('2026 Year Balance — Lazy Init Uses v2 (flat 28 days)');

// No 2026 balance exists yet
const before = db.prepare(
  'SELECT * FROM year_balances WHERE employee_id = ? AND year = 2026'
).get('mm');
assert('No 2026 balance exists before lazy init', before == null);

// Trigger lazy init
const balance2026 = ensureYearBalance('mm', 2026);

assert('2026 balance created by lazy init', balance2026 != null);
assert('2026 balance references policy v2', balance2026?.policy_id === policyV2?.id);

// v2 is flat 28 days × 100% = 28
assert('2026 entitlement = 28 days (v2 flat rule)', balance2026?.vacation_entitlement === 28);


// ─────────────────────────────────────────────
// TEST 2.7 — Lazy init is idempotent
// ─────────────────────────────────────────────
section('Lazy Init Is Idempotent (runs twice = same result)');

const secondCall = ensureYearBalance('mm', 2026);
const allBalances2026 = db.prepare(
  'SELECT COUNT(*) as c FROM year_balances WHERE employee_id = ? AND year = 2026'
).get('mm');

assert('Still only 1 row for 2026 after second call', allBalances2026.c === 1);
assert('Same entitlement on second call', secondCall?.vacation_entitlement === balance2026?.vacation_entitlement);

// ─────────────────────────────────────────────
// TEST 2.8 — Carryover calculated correctly into 2026
// ─────────────────────────────────────────────
section('Carryover from 2025 into 2026');

// Max 2025: entitlement=23, carryover=3, used=2 vacation days (from seed)
// Unused = 23 + 3 - 2 = 24. Cap = 5. So carryover = min(24, 5) = 5
assert('Max 2026 vacation carryover capped at 5 days', balance2026?.vacation_carryover === 5);

// OT carryover: Max had 8h OT carryover from 2024 + 10 work entries × 0.5h OT = 5h + 2 Aug entries × 0.5h = 1h
// Total OT = 8 + 5 + 1 = 14h
const expectedOT = round1(
  mmBalance2025.overtime_carryover +   // 8h from 2024
  (10 * 0.5) +                          // 10 March entries × 0.5h OT each
  (2 * 0.5)                             // 2 August entries × 0.5h OT each
);
assert(`Max 2026 overtime carryover = ${expectedOT}h`, balance2026?.overtime_carryover === expectedOT);

// ─────────────────────────────────────────────
// TEST 2.9 — Point-in-time queries across versions
// ─────────────────────────────────────────────
section('Point-in-Time Policy Queries');

const dates = [
  ['2025-01-15', 1],
  ['2025-06-30', 1],
  ['2025-07-01', 2],
  ['2025-12-31', 2],
  ['2026-06-01', 2],
];

for (const [date, expectedVersion] of dates) {
  const p = getPolicyOn(date);
  assert(`Policy on ${date} = v${expectedVersion}`, p?.version === expectedVersion);
}

// ─────────────────────────────────────────────
// TEST 2.10 — No entries have NULL policy_id
// ─────────────────────────────────────────────
section('Data Integrity Checks');

const nullPolicy = db.prepare(
  `SELECT COUNT(*) as c FROM time_entries WHERE policy_id IS NULL AND entry_type = 'work'`
).get();
assert('No work entries with NULL policy_id', nullPolicy.c === 0);

const overlapping = db.prepare(`
  SELECT COUNT(*) as c FROM company_policies p1
  JOIN company_policies p2 ON p1.id != p2.id
  WHERE p1.effective_from < COALESCE(p2.effective_to, '9999-12-31')
    AND COALESCE(p1.effective_to, '9999-12-31') > p2.effective_from
`).get();
assert('No overlapping policy date ranges', overlapping.c === 0);

// ─────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────
console.log(`\n${'═'.repeat(52)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('  🎉 Group 2 passed! Policy versioning is solid.\n');
} else {
  console.log('  ⚠️  Some tests failed.\n');
}
