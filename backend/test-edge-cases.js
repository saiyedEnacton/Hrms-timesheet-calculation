/**
 * GROUP 9 — Edge Cases
 *
 * Scenarios:
 *   9.1  Leap year — Feb 29 2028 entry valid and queryable
 *   9.2  Year boundary — Dec 31 and Jan 1 entries hit correct year balances
 *   9.3  Duplicate entry rejected by UNIQUE constraint
 *   9.4  No active policy on a date — detected before insert
 *   9.5  Overlapping policies — integrity check catches it
 *   9.6  Work entry without clock_in/clock_out — flagged by validation
 *   9.7  Employee with no year_balance — graceful null return
 *   9.8  Entry cannot reference a policy inactive on its work_date
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

// Safe insert: validates before writing, returns { ok, error }
function safeLogWork(employeeId, date, clockIn, clockOut, breakMin) {
  // Validation 1: policy must exist for this date
  const policy = getPolicyOn(date);
  if (!policy) {
    return { ok: false, error: `No active policy on ${date}` };
  }

  // Validation 2: work entry must have clock_in and clock_out
  if (!clockIn || !clockOut) {
    return { ok: false, error: 'Work entry requires clock_in and clock_out' };
  }

  // Validation 3: policy must have been active on work_date (no future policy)
  if (policy.effective_from > date) {
    return { ok: false, error: `Policy ${policy.id} not yet active on ${date}` };
  }

  const inH  = parseInt(clockIn.split(':')[0])  + parseInt(clockIn.split(':')[1])  / 60;
  const outH = parseInt(clockOut.split(':')[0]) + parseInt(clockOut.split(':')[1]) / 60;
  const gross = round1(outH - inH - breakMin / 60);

  try {
    db.prepare(`
      INSERT INTO time_entries (
        employee_id, work_date, entry_type,
        clock_in, clock_out, break_minutes,
        hours, regular_hours, overtime_hours,
        policy_id, source, status
      ) VALUES (?, ?, 'work', ?, ?, ?, ?, ?, 0, ?, 'timesheet', 'approved')
    `).run(
      employeeId, date, clockIn, clockOut, breakMin,
      gross, Math.min(gross, 8),
      policy.id
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Check for overlapping policies
function findOverlappingPolicies() {
  return db.prepare(`
    SELECT p1.id as id1, p2.id as id2,
           p1.effective_from as from1, p1.effective_to as to1,
           p2.effective_from as from2, p2.effective_to as to2
    FROM company_policies p1
    JOIN company_policies p2 ON p1.id < p2.id
    WHERE p1.effective_from < COALESCE(p2.effective_to, '9999-12-31')
      AND COALESCE(p1.effective_to, '9999-12-31') > p2.effective_from
  `).all();
}

// ─────────────────────────────────────────────
// 9.1 — Leap year: Feb 29 2028
// ─────────────────────────────────────────────
section('9.1 Leap Year — Feb 29 2028');

// 2028 is a leap year (divisible by 4, not by 100, or by 400)
const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
assert('2028 is a leap year', isLeapYear(2028));
assert('2025 is not a leap year', !isLeapYear(2025));
assert('2100 is not a leap year', !isLeapYear(2100));
assert('2000 is a leap year',  isLeapYear(2000));

// SQLite stores dates as text — Feb 29 2028 is valid
const result = safeLogWork('mm', '2028-02-29', '08:00', '17:00', 30);
assert('Feb 29 2028 entry accepted by SQLite', result.ok === true);

const leapEntry = db.prepare(`SELECT * FROM time_entries WHERE employee_id='mm' AND work_date='2028-02-29'`).get();
assert('Leap day entry stored and queryable', leapEntry != null);
assert('Leap day entry date preserved exactly', leapEntry?.work_date === '2028-02-29');

// Querying by year still works
const leapYearEntries = db.prepare(`
  SELECT * FROM time_entries WHERE employee_id='mm' AND strftime('%Y', work_date) = '2028'
`).all();
assert('Leap year entries queryable by year', leapYearEntries.length >= 1);

// ─────────────────────────────────────────────
// 9.2 — Year boundary: Dec 31 and Jan 1
// ─────────────────────────────────────────────
section('9.2 Year Boundary — Dec 31 / Jan 1');

safeLogWork('mm', '2025-12-31', '08:00', '17:00', 30);
safeLogWork('mm', '2026-01-01', '08:00', '17:00', 30);  // Jan 1 = New Year holiday but entry still valid

const dec31 = db.prepare(`SELECT * FROM time_entries WHERE employee_id='mm' AND work_date='2025-12-31'`).get();
const jan01 = db.prepare(`SELECT * FROM time_entries WHERE employee_id='mm' AND work_date='2026-01-01'`).get();

assert('Dec 31 entry stored',                         dec31 != null);
assert('Jan 1 entry stored',                          jan01  != null);
assert('Dec 31 in year 2025',                         dec31?.work_date?.startsWith('2025'));
assert('Jan 1 in year 2026',                          jan01?.work_date?.startsWith('2026'));

// Each references the correct policy for its year
const policyDec = getPolicyOn('2025-12-31');
const policyJan = getPolicyOn('2026-01-01');
assert('Dec 31 references correct policy', dec31?.policy_id === policyDec?.id);
assert('Jan 1 references correct policy',  jan01?.policy_id === policyJan?.id);

// Year-based queries correctly separate them
const entries2025 = db.prepare(`
  SELECT COUNT(*) as c FROM time_entries WHERE employee_id='mm' AND strftime('%Y', work_date)='2025'
`).get();
const entries2026 = db.prepare(`
  SELECT COUNT(*) as c FROM time_entries WHERE employee_id='mm' AND strftime('%Y', work_date)='2026'
`).get();
assert('Dec 31 counted in 2025 query', entries2025.c >= 1);
assert('Jan 1 counted in 2026 query',  entries2026.c >= 1);

// ─────────────────────────────────────────────
// 9.3 — Duplicate entry rejected
// ─────────────────────────────────────────────
section('9.3 Duplicate Entry Rejected by UNIQUE Constraint');

// First insert should succeed
const first = safeLogWork('mm', '2025-11-03', '08:00', '17:00', 30);
assert('First entry on 2025-11-03 accepted', first.ok === true);

// Second insert for same employee + date + type should fail
const duplicate = safeLogWork('mm', '2025-11-03', '09:00', '18:00', 30);
assert('Duplicate entry rejected',              duplicate.ok    === false);
assert('Error mentions UNIQUE constraint',      duplicate.error?.toLowerCase().includes('unique'));

// Original entry untouched
const original = db.prepare(`SELECT * FROM time_entries WHERE employee_id='mm' AND work_date='2025-11-03'`).get();
assert('Original entry preserved after duplicate attempt', original?.clock_in === '08:00');

// ─────────────────────────────────────────────
// 9.4 — No active policy on a date
// ─────────────────────────────────────────────
section('9.4 No Active Policy on Date — Blocked Before Insert');

// Close current policy and leave a gap (no policy for year 2030)
// Don't actually close it — just test a date before policy starts
const noPolicyResult = safeLogWork('mm', '2010-06-01', '08:00', '17:00', 30);
assert('Entry blocked when no policy active on date', noPolicyResult.ok === false);
assert('Error describes missing policy',              noPolicyResult.error?.includes('No active policy'));

// Verify nothing was written
const ghostEntry = db.prepare(`SELECT * FROM time_entries WHERE employee_id='mm' AND work_date='2010-06-01'`).get();
assert('No entry written when policy missing',        ghostEntry == null);

// ─────────────────────────────────────────────
// 9.5 — Overlapping policies detected
// ─────────────────────────────────────────────
section('9.5 Overlapping Policies Detected by Integrity Check');

// Current state: one policy, no overlap
const cleanOverlaps = findOverlappingPolicies();
assert('No overlapping policies in clean state', cleanOverlaps.length === 0);

// Insert an overlapping policy (same date range as existing)
db.prepare(`
  INSERT INTO company_policies (
    version, weekly_hours, max_weekly_hours, daily_hours,
    age_based_vacation, default_vacation_days, age_ranges,
    carryover_allowed, max_carryover_days, premium_rates,
    effective_from, change_reason
  ) VALUES (99, 40, 48, 8, 1, 25, '[]', 1, 5, '{}', '2025-06-01', 'Accidental overlap')
`).run();

const overlaps = findOverlappingPolicies();
assert('Overlapping policy detected by integrity check', overlaps.length > 0);
assert('Overlap detection returns both conflicting IDs',  overlaps[0]?.id1 != null && overlaps[0]?.id2 != null);

// Clean up the bad policy
db.prepare(`DELETE FROM company_policies WHERE version = 99`).run();
const afterCleanup = findOverlappingPolicies();
assert('No overlaps after removing bad policy', afterCleanup.length === 0);

// ─────────────────────────────────────────────
// 9.6 — Work entry without clock_in/clock_out
// ─────────────────────────────────────────────
section('9.6 Work Entry Without Clock Times — Validation Blocks It');

const noClockIn  = safeLogWork('mm', '2025-11-10', null, '17:00', 30);
const noClockOut = safeLogWork('mm', '2025-11-10', '08:00', null, 30);
const noBoth     = safeLogWork('mm', '2025-11-10', null, null, 30);

assert('Entry blocked with no clock_in',         noClockIn.ok  === false);
assert('Entry blocked with no clock_out',         noClockOut.ok === false);
assert('Entry blocked with neither clock time',   noBoth.ok     === false);
assert('Error mentions clock requirement',        noClockIn.error?.includes('clock_in'));

// None of these created entries
const phantom = db.prepare(`SELECT * FROM time_entries WHERE employee_id='mm' AND work_date='2025-11-10'`).get();
assert('No phantom entry written after failed validation', phantom == null);

// ─────────────────────────────────────────────
// 9.7 — Employee with no year_balance
// ─────────────────────────────────────────────
section('9.7 Missing Year Balance — Graceful Null Return');

// Query year_balance for an employee in a year they have no record
const missingBalance = db.prepare(
  'SELECT * FROM year_balances WHERE employee_id=? AND year=?'
).get('mm', 2020);

assert('Returns null (not crash) for missing year balance', missingBalance == null);

// Safe balance query handles null gracefully
function safeVacationRemaining(employeeId, year) {
  const balance = db.prepare(
    'SELECT * FROM year_balances WHERE employee_id=? AND year=?'
  ).get(employeeId, year);

  if (!balance) return null;

  const used = db.prepare(`
    SELECT COALESCE(SUM(hours)/8.0, 0) as d FROM time_entries
    WHERE employee_id=? AND entry_type='vacation' AND strftime('%Y', work_date)=?
  `).get(employeeId, String(year))?.d || 0;

  return round1(balance.vacation_entitlement + balance.vacation_carryover - used);
}

const result2020 = safeVacationRemaining('mm', 2020);
assert('Safe function returns null for missing year',    result2020 === null);
assert('Safe function returns value for existing year',  safeVacationRemaining('mm', 2025) !== null);

// ─────────────────────────────────────────────
// 9.8 — Entry cannot reference future policy
// ─────────────────────────────────────────────
section('9.8 Entry Cannot Reference Future Policy');

// Create a future policy
db.prepare(`
  INSERT INTO company_policies (
    version, weekly_hours, max_weekly_hours, daily_hours,
    age_based_vacation, default_vacation_days, age_ranges,
    carryover_allowed, max_carryover_days, premium_rates,
    effective_from, change_reason
  ) VALUES (5, 38, 46, 8, 1, 25, '[]', 1, 5, '{}', '2030-01-01', 'Future policy')
`).run();

const futurePolicy = db.prepare(`SELECT * FROM company_policies WHERE version=5`).get();

// The safeLogWork validation uses getPolicyOn(date) which returns
// the policy ACTIVE on that date — not a future policy
const todayPolicy   = getPolicyOn('2025-08-01');
const futureOnToday = getPolicyOn('2025-08-01');

assert('Policy lookup on 2025-08-01 does NOT return future policy', todayPolicy?.version !== 5);

// Directly verify: an entry for a past date should reference a past policy
const pastEntry = safeLogWork('mm', '2025-08-04', '08:00', '17:00', 30);
const storedEntry = db.prepare(`SELECT * FROM time_entries WHERE employee_id='mm' AND work_date='2025-08-04'`).get();

assert('Entry for Aug 2025 inserted ok',               pastEntry.ok === true);
assert('Entry does not reference future policy v5',    storedEntry?.policy_id !== futurePolicy?.id);

// The future policy should only be resolved for future dates
const futureResolved = getPolicyOn('2030-06-01');
assert('Future policy resolves correctly for future date', futureResolved?.version === 5);

// Clean up future policy
db.prepare(`DELETE FROM company_policies WHERE version=5`).run();

// ─────────────────────────────────────────────
// Final: all entries have valid policy references
// ─────────────────────────────────────────────
section('Final Integrity Check');

const orphanedEntries = db.prepare(`
  SELECT COUNT(*) as c FROM time_entries
  WHERE policy_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM company_policies WHERE id = time_entries.policy_id)
`).get();
assert('No entries reference deleted policies', orphanedEntries.c === 0);

const workWithoutTimes = db.prepare(`
  SELECT COUNT(*) as c FROM time_entries
  WHERE entry_type = 'work' AND (clock_in IS NULL OR clock_out IS NULL)
`).get();
assert('No work entries missing clock times', workWithoutTimes.c === 0);

// ─────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────
console.log(`\n${'═'.repeat(52)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('  🎉 Group 9 passed! All edge cases handled.\n');
} else {
  console.log('  ⚠️  Some tests failed.\n');
}
