/**
 * GROUP 4 — Premium Calculations
 *
 * Scenarios:
 *   4.1  Regular weekday — no premiums (sanity baseline)
 *   4.2  Sunday premium — all hours on Sunday qualify
 *   4.3  Public holiday premium — all hours on holiday qualify
 *   4.4  Night shift premium — only hours in 23:00–06:00 window counted
 *   4.5  Stacked: Sunday + company holiday + night — all three apply independently
 *   4.6  Holiday + overtime under v2 — premium + OT coexist, different daily threshold
 *   4.7  Extratime — weekly total exceeds 48h max_weekly threshold
 *   4.8  Rate change historical accuracy — frozen snapshot preserves original rate
 *
 * Key employee: pk (Peter Keller, 100%, hired 2025-03-01) — no seed entries, clean slate
 * Key dates verified:
 *   2025-03-10 = Monday     2025-03-16 = Sunday     2025-03-17 = Monday
 *   2025-04-06 = Sunday     2025-04-14 = Monday     2025-05-01 = Thursday (holiday)
 *   2025-08-01 = Friday (holiday)   2025-10-05 = Sunday
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

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const toMin = t => parseInt(t.split(':')[0]) * 60 + parseInt(t.split(':')[1]);

function calcGrossHours(clockIn, clockOut, breakMin) {
  let inMin  = toMin(clockIn);
  let outMin = toMin(clockOut);
  if (outMin <= inMin) outMin += 1440;    // spans midnight
  return round1((outMin - inMin - breakMin) / 60);
}

/**
 * Count hours that fall inside the 23:00–06:00 night window.
 * The window crosses midnight, so we split it into two segments and sum overlaps:
 *   Segment A: [nsMin, 1440)          → pre-midnight portion
 *   Segment B: [1440, 1440 + neMin)   → post-midnight portion (normalized)
 */
function calcNightHours(clockIn, clockOut, nightStart = '23:00', nightEnd = '06:00') {
  let inMin  = toMin(clockIn);
  let outMin = toMin(clockOut);
  if (outMin <= inMin) outMin += 1440;

  const nsMin = toMin(nightStart);         // 1380  (23 × 60)
  const neMin = toMin(nightEnd);           //  360  ( 6 × 60)

  const o1 = Math.max(0, Math.min(outMin, 1440)            - Math.max(inMin, nsMin));
  const o2 = Math.max(0, Math.min(outMin, 1440 + neMin)    - Math.max(inMin, 1440));
  return round1((o1 + o2) / 60);
}

function isSunday(dateStr) {
  return new Date(dateStr).getDay() === 0;
}

function getPolicyOn(date) {
  return db.prepare(`
    SELECT * FROM company_policies
    WHERE effective_from <= ?
      AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY effective_from DESC LIMIT 1
  `).get(date, date);
}

function getHoliday(dateStr) {
  return db.prepare(`SELECT * FROM public_holidays WHERE date = ?`).get(dateStr);
}

function getEntry(employeeId, date) {
  return db.prepare(`
    SELECT te.*, cp.version AS cp_version
    FROM time_entries te
    LEFT JOIN company_policies cp ON te.policy_id = cp.id
    WHERE te.employee_id = ? AND te.work_date = ?
  `).get(employeeId, date);
}

/**
 * Calculate premiums and insert a work entry.
 * Premium columns store eligible hours (not money).
 * The rate lives frozen in the snapshot for payroll reconstruction.
 */
function logPremiumWork(employeeId, date, clockIn, clockOut, breakMin) {
  const policy   = getPolicyOn(date);
  if (!policy) { console.error(`  ⚠️  No policy found for ${date}`); return null; }

  const rates    = JSON.parse(policy.premium_rates);
  const gross    = calcGrossHours(clockIn, clockOut, breakMin);
  const regular  = Math.min(gross, policy.daily_hours);
  const overtime = round1(Math.max(0, gross - policy.daily_hours));

  const sundayHours  = isSunday(date) && rates.sunday?.enabled  ? gross : 0;
  const holiday      = getHoliday(date);
  const holidayHours = holiday        && rates.holiday?.enabled ? gross : 0;
  const nightHours   = rates.night?.enabled
    ? calcNightHours(clockIn, clockOut, rates.night.startTime, rates.night.endTime)
    : 0;

  try {
    db.prepare(`
      INSERT OR IGNORE INTO time_entries (
        employee_id, work_date, entry_type,
        clock_in, clock_out, break_minutes,
        hours, regular_hours, overtime_hours,
        sunday_premium, holiday_premium, night_premium,
        policy_id, source, status
      ) VALUES (?, ?, 'work', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'timesheet', 'approved')
    `).run(
      employeeId, date, clockIn, clockOut, breakMin,
      gross, regular, overtime,
      sundayHours, holidayHours, nightHours,
      policy.id
    );
  } catch (err) {
    console.error(`  ⚠️  Insert failed for ${employeeId} on ${date}: ${err.message}`);
  }

  return { gross, regular, overtime, sundayHours, holidayHours, nightHours, policyVersion: policy.version };
}

// ─────────────────────────────────────────────────────────────
// TEST 4.1 — Regular Weekday, No Premiums (sanity baseline)
// ─────────────────────────────────────────────────────────────
section('4.1 Regular Weekday — Zero Premiums');

// pk, 2025-03-10 (Monday), 08:00–16:30, 30min break
// Expected: 8h gross, 8h regular, 0 OT, zero all premiums
logPremiumWork('pk', '2025-03-10', '08:00', '16:30', 30);
const e41 = getEntry('pk', '2025-03-10');

assert('Entry created',                                   e41 != null);
assert('Gross hours = 8h',                                e41?.hours === 8);
assert('Regular hours = 8h (at daily limit)',             e41?.regular_hours === 8);
assert('Overtime = 0',                                    e41?.overtime_hours === 0);
assert('Sunday premium = 0',                              e41?.sunday_premium === 0);
assert('Holiday premium = 0',                             e41?.holiday_premium === 0);
assert('Night premium = 0',                               e41?.night_premium === 0);

// ─────────────────────────────────────────────────────────────
// TEST 4.2 — Sunday Premium
// ─────────────────────────────────────────────────────────────
section('4.2 Sunday Premium');

// pk, 2025-03-16 (Sunday), 08:00–17:00, 30min break
// Policy v1: sunday_rate = 100%. All gross hours qualify.
// 8.5h gross, 8h regular, 0.5h OT (v1 daily_hours=8)
logPremiumWork('pk', '2025-03-16', '08:00', '17:00', 30);
const e42 = getEntry('pk', '2025-03-16');

assert('2025-03-16 is Sunday',                            isSunday('2025-03-16'));
assert('Entry created',                                   e42 != null);
assert('Gross hours = 8.5h',                              e42?.hours === 8.5);
assert('Regular = 8h',                                    e42?.regular_hours === 8);
assert('Overtime = 0.5h (v1 daily>8h)',                  e42?.overtime_hours === 0.5);
assert('Sunday premium = 8.5h (all gross hours)',         e42?.sunday_premium === 8.5);
assert('Holiday premium = 0 (not a holiday)',             e42?.holiday_premium === 0);
assert('Night premium = 0 (day shift)',                   e42?.night_premium === 0);

// ─────────────────────────────────────────────────────────────
// TEST 4.3 — Public Holiday Premium
// ─────────────────────────────────────────────────────────────
section('4.3 Public Holiday Premium (Tag der Arbeit)');

// pk, 2025-05-01 (Thursday, Tag der Arbeit), 08:00–17:00, 30min break
// Policy v1: holiday_rate = 100%. All gross hours qualify.
logPremiumWork('pk', '2025-05-01', '08:00', '17:00', 30);
const e43 = getEntry('pk', '2025-05-01');

assert('2025-05-01 is in public_holidays table',          getHoliday('2025-05-01') != null);
assert('Entry created',                                   e43 != null);
assert('Gross hours = 8.5h',                              e43?.hours === 8.5);
assert('Holiday premium = 8.5h (all gross hours)',        e43?.holiday_premium === 8.5);
assert('Sunday premium = 0 (Thursday)',                   e43?.sunday_premium === 0);
assert('Night premium = 0',                               e43?.night_premium === 0);

// ─────────────────────────────────────────────────────────────
// TEST 4.4 — Night Shift Premium
// ─────────────────────────────────────────────────────────────
section('4.4 Night Shift Premium (23:00–06:00 window)');

// pk, 2025-03-17 (Monday), 22:00–07:00, 0 break = 9h gross
// Night window overlap: [23:00,24:00) = 1h + [00:00,06:00) = 6h → 7h total
// OT: 9 - 8 (v1 daily) = 1h
logPremiumWork('pk', '2025-03-17', '22:00', '07:00', 0);
const e44 = getEntry('pk', '2025-03-17');

assert('Entry created (spans midnight)',                  e44 != null);
assert('Gross hours = 9h',                                e44?.hours === 9);
assert('Regular = 8h (v1 daily_hours)',                  e44?.regular_hours === 8);
assert('Overtime = 1h (9 − 8)',                          e44?.overtime_hours === 1);
assert('Night premium = 7h (23:00–06:00 overlap)',       e44?.night_premium === 7);
assert('Sunday premium = 0 (Monday)',                    e44?.sunday_premium === 0);
assert('Holiday premium = 0',                            e44?.holiday_premium === 0);

// Verify helper logic directly
assert('calcNightHours("22:00","07:00") = 7',            calcNightHours('22:00', '07:00') === 7);
assert('calcNightHours("08:00","17:00") = 0 (day)',      calcNightHours('08:00', '17:00') === 0);
assert('calcNightHours("23:00","06:00") = 7 (full)',     calcNightHours('23:00', '06:00') === 7);

// ─────────────────────────────────────────────────────────────
// TEST 4.5 — Stacked: Sunday + Company Holiday + Night
// ─────────────────────────────────────────────────────────────
section('4.5 Stacked: Sunday + Holiday + Night (all three)');

// 2025-04-06 = Sunday. Insert a test company holiday on the same date.
// pk, 22:00–07:00, 0 break = 9h gross, night = 7h
// All three premiums apply independently — they are not mutually exclusive.
db.prepare(`
  INSERT OR IGNORE INTO public_holidays (date, name, type, recurring, region)
  VALUES ('2025-04-06', 'Test Company Day', 'company', 0, 'CH')
`).run();

logPremiumWork('pk', '2025-04-06', '22:00', '07:00', 0);
const e45 = getEntry('pk', '2025-04-06');

assert('2025-04-06 is Sunday',                            isSunday('2025-04-06'));
assert('Test holiday exists on 2025-04-06',               getHoliday('2025-04-06') != null);
assert('Entry created',                                   e45 != null);
assert('Gross = 9h',                                      e45?.hours === 9);
assert('Sunday premium = 9h (all hours)',                 e45?.sunday_premium === 9);
assert('Holiday premium = 9h (all hours)',                e45?.holiday_premium === 9);
assert('Night premium = 7h (23:00–06:00)',               e45?.night_premium === 7);

// ─────────────────────────────────────────────────────────────
// TEST 4.6 — Holiday + Overtime (daily threshold from active policy)
// ─────────────────────────────────────────────────────────────
section('4.6 Holiday + Overtime (policy threshold, Bundesfeier 2025-08-01)');

// pk, 2025-08-01 (Bundesfeier, Friday), 08:00–17:30, 0 break = 9.5h gross.
// Key assertion: holiday premium covers ALL gross hours (OT portion included).
// Policy version depends on what was applied by earlier test groups.
// Delete any stale entry so we always re-calculate with the current DB policy.
db.prepare(`DELETE FROM time_entries WHERE employee_id = 'pk' AND work_date = '2025-08-01'`).run();

const p46   = getPolicyOn('2025-08-01');
const calc46 = logPremiumWork('pk', '2025-08-01', '08:00', '17:30', 0);
const e46   = getEntry('pk', '2025-08-01');

const exp46Regular  = Math.min(9.5, p46.daily_hours);
const exp46Overtime = round1(Math.max(0, 9.5 - p46.daily_hours));

assert('Entry created',                                   e46 != null);
assert('Entry references active policy',                  e46?.cp_version === p46.version);
assert('Gross hours = 9.5h',                              e46?.hours === 9.5);
assert(`Regular = ${exp46Regular}h (active daily_hours)`, e46?.regular_hours === exp46Regular);
assert(`Overtime = ${exp46Overtime}h (9.5 − ${p46.daily_hours})`, e46?.overtime_hours === exp46Overtime);
assert('Holiday premium = 9.5h (ALL gross hours, incl OT)', e46?.holiday_premium === 9.5);
assert('Sunday premium = 0 (Friday)',                     e46?.sunday_premium === 0);
assert('Night premium = 0 (day shift)',                   e46?.night_premium === 0);

// ─────────────────────────────────────────────────────────────
// TEST 4.7 — Extratime (Weekly Total Exceeds Max 48h)
// ─────────────────────────────────────────────────────────────
section('4.7 Extratime — 50h/week Exceeds 48h Max Threshold');

// mm, Mon–Fri 2025-04-14 to 2025-04-18, 09:00–19:00 (10h/day, 0 break)
// Policy v1: weekly_hours=40, max_weekly_hours=48
// Weekly total: 50h → regular=40 (first 40h), true OT=8 (40–48h), extratime=2 (>48h)
// Each entry stored with daily calc: regular=8, OT=2 (daily>8h threshold)
const extratimeWeek = [
  ['2025-04-14', '09:00', '19:00'],  // Monday
  ['2025-04-15', '09:00', '19:00'],  // Tuesday
  ['2025-04-16', '09:00', '19:00'],  // Wednesday
  ['2025-04-17', '09:00', '19:00'],  // Thursday
  ['2025-04-18', '09:00', '19:00'],  // Friday
];

for (const [date, ci, co] of extratimeWeek) {
  logPremiumWork('mm', date, ci, co, 0);
}

const weekRows = db.prepare(`
  SELECT COUNT(*)            AS entry_count,
         SUM(hours)          AS total_hours,
         SUM(regular_hours)  AS total_regular,
         SUM(overtime_hours) AS total_ot_daily
  FROM time_entries
  WHERE employee_id = 'mm'
    AND work_date BETWEEN '2025-04-14' AND '2025-04-18'
    AND entry_type = 'work'
`).get();

const wkPolicy     = getPolicyOn('2025-04-14');
const wkRates      = JSON.parse(wkPolicy.premium_rates);
const weekTotal    = round1(weekRows.total_hours);
const weekTrueOT   = round1(Math.max(0, Math.min(weekTotal, wkPolicy.max_weekly_hours) - wkPolicy.weekly_hours));
const weekExtratime = round1(Math.max(0, weekTotal - wkPolicy.max_weekly_hours));

assert('5 entries inserted for the week',                 weekRows.entry_count === 5);
assert('Weekly gross total = 50h',                        weekTotal === 50);
assert('Weekly regular sum = 40h (5 × 8)',               round1(weekRows.total_regular) === 40);
assert('Weekly true OT (40–48h) = 8h',                   weekTrueOT   === 8,  `got ${weekTrueOT}`);
assert('Weekly extratime (>48h) = 2h',                    weekExtratime === 2,  `got ${weekExtratime}`);
assert('Policy max_weekly_hours = 48 (v1)',               wkPolicy.max_weekly_hours === 48);
assert('Extratime premium rate = 25% in policy',          wkRates.extratime.rate === 25);

// ─────────────────────────────────────────────────────────────
// TEST 4.8 — Rate Change: Historical Snapshots Are Immutable
// ─────────────────────────────────────────────────────────────
section('4.8 Rate Change — Historical Snapshots Preserved');

// Get policy v1 for reference
const policyV1 = getPolicyOn('2025-03-01');

// Step 1: confirm existing Sunday entry (from 4.2) still has correct premium hours
const oldEntry = getEntry('pk', '2025-03-16');

assert('Old Sunday entry exists (from 4.2)',              oldEntry != null);
assert('Old entry: policy_id references v1',              oldEntry?.policy_id === policyV1?.id);
assert('Old entry: sunday premium = 8.5h',                oldEntry?.sunday_premium === 8.5);

// Step 2: simulate rate change — close v2, insert v3 with sunday rate = 50%
const currentV2 = getPolicyOn('2025-09-15');
const v2Id      = currentV2.id;
const v2Rates   = JSON.parse(currentV2.premium_rates);

db.prepare(`UPDATE company_policies SET effective_to = '2025-09-30' WHERE id = ?`).run(v2Id);

const v3Rates = { ...v2Rates, sunday: { ...v2Rates.sunday, rate: 50 } };
const v3Insert = db.prepare(`
  INSERT INTO company_policies (
    version, weekly_hours, max_weekly_hours, daily_hours,
    age_based_vacation, default_vacation_days, age_ranges,
    carryover_allowed, max_carryover_days,
    premium_rates, effective_from, change_reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  3,
  currentV2.weekly_hours, currentV2.max_weekly_hours, currentV2.daily_hours,
  currentV2.age_based_vacation, currentV2.default_vacation_days, currentV2.age_ranges,
  currentV2.carryover_allowed, currentV2.max_carryover_days,
  JSON.stringify(v3Rates),
  '2025-10-01',
  'Sunday premium reduced 100% → 50%'
);
const v3Id = v3Insert.lastInsertRowid;

// Step 3: insert a new Sunday entry under v3
// 2025-10-05 = Sunday (Oct 1 = Wed, +4 = Sun)
logPremiumWork('pk', '2025-10-05', '08:00', '17:00', 30);
const newEntry = getEntry('pk', '2025-10-05');

const policyV3 = db.prepare(`SELECT * FROM company_policies WHERE id = ?`).get(v3Id);

assert('2025-10-05 is Sunday',                            isSunday('2025-10-05'));
assert('New entry created under v3',                      newEntry != null);
assert('New entry references v3 policy',                  newEntry?.policy_id === v3Id);
assert('New entry: sunday premium = 8.5h (same hours)',   newEntry?.sunday_premium === 8.5);

// Step 4: critical — old entry is completely untouched
const oldEntryReread = getEntry('pk', '2025-03-16');

assert('Old entry STILL references v1 policy',            oldEntryReread?.policy_id === policyV1?.id);
assert('Old entry STILL has 8.5h sunday premium',         oldEntryReread?.sunday_premium === 8.5);
assert('Both entries have premium hours, policy_id differs',
  oldEntryReread?.policy_id === policyV1?.id &&
  newEntry?.policy_id       === v3Id);

// ─────────────────────────────────────────────────────────────
// CLEANUP — Remove test-only data
// ─────────────────────────────────────────────────────────────
section('Cleanup — Remove Test-Only Data');

db.prepare(`DELETE FROM time_entries WHERE employee_id = 'pk' AND work_date = '2025-10-05'`).run();
db.prepare(`DELETE FROM company_policies WHERE id = ?`).run(v3Id);
db.prepare(`UPDATE company_policies SET effective_to = NULL WHERE id = ?`).run(v2Id);
db.prepare(`DELETE FROM public_holidays WHERE name = 'Test Company Day'`).run();

assert('Test entry 2025-10-05 removed',
  db.prepare(`SELECT COUNT(*) AS c FROM time_entries WHERE employee_id='pk' AND work_date='2025-10-05'`).get().c === 0);
assert('v3 policy removed',
  db.prepare(`SELECT COUNT(*) AS c FROM company_policies WHERE id = ?`).get(v3Id).c === 0);
assert('v2 policy reopened (effective_to = NULL)',
  db.prepare(`SELECT effective_to FROM company_policies WHERE id = ?`).get(v2Id)?.effective_to == null);
assert('Test holiday removed',
  db.prepare(`SELECT COUNT(*) AS c FROM public_holidays WHERE name = 'Test Company Day'`).get().c === 0);

// ─────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(52)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('  🎉 Group 4 passed! Premium calculations are solid.\n');
} else {
  console.log('  ⚠️  Some tests failed. Check output above.\n');
}
