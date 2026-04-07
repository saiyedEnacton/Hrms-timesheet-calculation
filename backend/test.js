import db from './db.js';

// ─────────────────────────────────────────────
// Simple assertion helper
// ─────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ' → ' + detail : ''}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(4, 50 - title.length))}`);
}

// ─────────────────────────────────────────────
// TEST 1: Tables exist
// ─────────────────────────────────────────────
section('Tables');

const tables = db.prepare(`
  SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
`).all().map(r => r.name);

const expected = ['balance_adjustments','company_policies','employment_contracts','employees','public_holidays','time_entries','year_balances'];
for (const t of expected) {
  assert(`Table "${t}" exists`, tables.includes(t));
}

// ─────────────────────────────────────────────
// TEST 2: Employees seeded correctly
// ─────────────────────────────────────────────
section('Employees');

const allEmployees = db.prepare('SELECT * FROM employees').all();
assert('6 employees seeded', allEmployees.length === 6);

const mm = db.prepare('SELECT * FROM employees WHERE id = ?').get('mm');
assert('Max Müller exists', mm?.name === 'Max Müller');

const mmContract = db.prepare('SELECT * FROM employment_contracts WHERE employee_id = ? AND effective_to IS NULL').get('mm');
assert('Max has active contract at 100%', mmContract?.work_percentage === 100);

const as = db.prepare('SELECT * FROM employment_contracts WHERE employee_id = ? AND effective_to IS NULL').get('as');
assert('Anna is 80% part-time', as?.work_percentage === 80 && as?.weekly_target_hours === 32);

const tw = db.prepare('SELECT * FROM employment_contracts WHERE employee_id = ? AND effective_to IS NULL').get('tw');
assert('Thomas is 60% part-time', tw?.work_percentage === 60 && tw?.weekly_target_hours === 24);

// ─────────────────────────────────────────────
// TEST 3: Vacation entitlement from policy
// ─────────────────────────────────────────────
section('Vacation Entitlement (Year Balances)');

const mmBalance = db.prepare('SELECT * FROM year_balances WHERE employee_id = ? AND year = 2025').get('mm');
// Max age 28 in 2025 → 23 days × 100% = 23 days, + 3 carryover
assert('Max: 23 days entitlement (age 28, 100%)', mmBalance?.vacation_entitlement === 23);
assert('Max: 3 days carryover from 2024', mmBalance?.vacation_carryover === 3);

const asBalance = db.prepare('SELECT * FROM year_balances WHERE employee_id = ? AND year = 2025').get('as');
// Anna age 35 → 23 days × 80% = 18.4 days
assert('Anna: 18.4 days entitlement (age 35, 80%)', asBalance?.vacation_entitlement === 18.4);

const pkBalance = db.prepare('SELECT * FROM year_balances WHERE employee_id = ? AND year = 2025').get('pk');
// Peter age 52 → 29 days × 100% = 29 days
assert('Peter: 29 days entitlement (age 52, 50+ bracket)', pkBalance?.vacation_entitlement === 29);

const lmBalance = db.prepare('SELECT * FROM year_balances WHERE employee_id = ? AND year = 2025').get('lm');
// Lisa age 19 → 29 days × 100% = 29 days
assert('Lisa: 29 days entitlement (age 19, under-20 bracket)', lmBalance?.vacation_entitlement === 29);

// ─────────────────────────────────────────────
// TEST 4: Time entries and snapshots
// ─────────────────────────────────────────────
section('Time Entries');

const mmEntries = db.prepare(`SELECT * FROM time_entries WHERE employee_id = 'mm' ORDER BY work_date`).all();
assert('Max has 12 time entries (10 work + 2 vacation)', mmEntries.length === 12);

const workEntries = mmEntries.filter(e => e.entry_type === 'work');
const vacEntries  = mmEntries.filter(e => e.entry_type === 'vacation');
assert('Max has 10 work entries', workEntries.length === 10);
assert('Max has 2 vacation entries', vacEntries.length === 2);

// Check overtime is stored
const dayWithOT = workEntries[0];
assert('Work entry has overtime_hours stored', dayWithOT.overtime_hours === 0.5); // 8.5 - 8 = 0.5

// Check snapshot is valid JSON
const snap = JSON.parse(dayWithOT.snapshot);
assert('Snapshot is valid JSON with policy_id', snap?.policy_id != null);
assert('Snapshot has calculation result', snap?.result?.regular_hours != null);

// Anna sick day
const annaSick = db.prepare(`SELECT * FROM time_entries WHERE employee_id = 'as' AND entry_type = 'sick'`).get();
assert('Anna has 1 sick day entry', annaSick != null);

// ─────────────────────────────────────────────
// TEST 5: Policy exists and is parseable
// ─────────────────────────────────────────────
section('Company Policy');

const policy = db.prepare('SELECT * FROM company_policies WHERE effective_to IS NULL').get();
assert('Active policy exists', policy != null);
assert('Weekly hours = 40', policy?.weekly_hours === 40);

const premiums = JSON.parse(policy?.premium_rates);
assert('Premium rates parseable', premiums != null);
assert('Overtime threshold = 40h', premiums?.overtime?.threshold === 40);
assert('Holiday rate = 100%', premiums?.holiday?.rate === 100);

const ageRanges = JSON.parse(policy?.age_ranges);
assert('Age ranges parseable', Array.isArray(ageRanges));
assert('3 age brackets defined', ageRanges.length === 3);

// ─────────────────────────────────────────────
// TEST 6: Point-in-time query (the key scenario)
// Given any date, can we get the right policy?
// ─────────────────────────────────────────────
section('Point-in-Time Policy Resolution');

const queryDate = '2025-03-05';
const policyOnDate = db.prepare(`
  SELECT * FROM company_policies
  WHERE effective_from <= ?
    AND (effective_to IS NULL OR effective_to >= ?)
  ORDER BY effective_from DESC
  LIMIT 1
`).get(queryDate, queryDate);
assert(`Policy resolved for ${queryDate}`, policyOnDate != null);

// ─────────────────────────────────────────────
// TEST 7: Vacation remaining calculation
// No stored "remaining" - we derive it from parts
// ─────────────────────────────────────────────
section('Vacation Remaining (derived)');

const mmVacUsed = db.prepare(`
  SELECT SUM(hours) / 8.0 as days_used
  FROM time_entries
  WHERE employee_id = 'mm' AND entry_type = 'vacation' AND strftime('%Y', work_date) = '2025'
`).get();

const mmYearBal = db.prepare('SELECT * FROM year_balances WHERE employee_id = ? AND year = 2025').get('mm');
const remaining = (mmYearBal.vacation_entitlement + mmYearBal.vacation_carryover) - (mmVacUsed?.days_used || 0);
assert(`Max vacation remaining = ${remaining} days (23 + 3 carryover - 2 used)`, remaining === 24);

// ─────────────────────────────────────────────
// TEST 8: Public holidays
// ─────────────────────────────────────────────
section('Public Holidays');

const hols = db.prepare('SELECT * FROM public_holidays').all();
assert('10 Swiss holidays seeded', hols.length === 10);

const christmas = db.prepare(`SELECT * FROM public_holidays WHERE date = '2025-12-25'`).get();
assert('Christmas is a public holiday', christmas?.name === 'Weihnachten');

// ─────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────
console.log(`\n${'═'.repeat(52)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('  🎉 All tests passed! Schema is solid.\n');
} else {
  console.log('  ⚠️  Some tests failed. Review schema/seed.\n');
}
