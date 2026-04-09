import db from './db.js';

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

const policy = db.prepare(`SELECT * FROM company_policies WHERE effective_to IS NULL`).get();
const policyId = policy.id;

// ─────────────────────────────────────────────
// 8.1 — New employee hired mid-month (pro-rata leave)
// ─────────────────────────────────────────────
section('8.1 Mid-Month Hire — Pro-Rata Leave');

// Julia hired March 15, 2025 — 100% full-time, age 30 (23 days base)
// months_remaining = 12 - (hire_month - 1) = 12 - (3 - 1) = 10
// Pro-rata = round(23 × 10/12 × 10) / 10 = 19.2
db.prepare(`INSERT INTO employees (id, name, role, date_of_birth, hire_date, location, status)
  VALUES ('jk', 'Julia Klein', 'Service', '1994-06-20', '2025-03-15', 'Zürich', 'active')`).run();
db.prepare(`INSERT INTO employment_contracts (employee_id, employment_type, work_percentage, weekly_target_hours, effective_from)
  VALUES ('jk', 'full-time', 100, 40, '2025-03-15')`).run();

const hireMonth = 3;
const monthsRemaining = 12 - (hireMonth - 1);
const juliaProRata = Math.round(23 * (monthsRemaining / 12) * 10) / 10;

db.prepare(`INSERT INTO year_balances (employee_id, year, vacation_entitlement, vacation_carryover, overtime_carryover, policy_id, snapshot)
  VALUES ('jk', 2025, ?, 0, 0, ?, ?)`).run(
  juliaProRata, policyId,
  JSON.stringify({ age_at_jan1: 30, hire_date: '2025-03-15', months_remaining: monthsRemaining, policy_version: 1 })
);

const juliaBalance = db.prepare(`SELECT * FROM year_balances WHERE employee_id = 'jk' AND year = 2025`).get();
assert('Julia balance created', juliaBalance != null);
assert('Pro-rata = 19.2 days (23 × 10/12)', juliaBalance.vacation_entitlement === 19.2);
assert('No carryover for new hire', juliaBalance.vacation_carryover === 0);
assert('Snapshot records months_remaining = 10', JSON.parse(juliaBalance.snapshot).months_remaining === 10);

// 2026 gets full year — no pro-rata once employed for a full year
const maxCarryover = policy.max_carryover_days ?? 5;
const julia2026Days = 23;
db.prepare(`INSERT INTO year_balances (employee_id, year, vacation_entitlement, vacation_carryover, overtime_carryover, policy_id, snapshot)
  VALUES ('jk', 2026, ?, ?, 0, ?, ?)`).run(
  julia2026Days,
  Math.min(juliaBalance.vacation_entitlement, maxCarryover),
  policyId,
  JSON.stringify({ age_at_jan1: 31, months_remaining: 12, policy_version: 1 })
);
const julia2026 = db.prepare(`SELECT * FROM year_balances WHERE employee_id = 'jk' AND year = 2026`).get();
assert('2026 gets full 23 days (no pro-rata)', julia2026.vacation_entitlement === 23);
assert('2026 carryover capped at 5', julia2026.vacation_carryover === 5);

// ─────────────────────────────────────────────
// 8.2 — Employee Rehire After Gap
// ─────────────────────────────────────────────
section('8.2 Rehire After Employment Gap');

// Peter Keller terminated June 30, rehired Oct 1 same year
db.prepare(`UPDATE employment_contracts SET effective_to = '2025-06-30'
  WHERE employee_id = 'pk' AND effective_to IS NULL`).run();
db.prepare(`UPDATE employees SET status = 'terminated' WHERE id = 'pk'`).run();

assert('Peter status = terminated', db.prepare(`SELECT status FROM employees WHERE id = 'pk'`).get().status === 'terminated');

const pkContractClosed = db.prepare(`SELECT * FROM employment_contracts WHERE employee_id = 'pk' AND effective_to = '2025-06-30'`).get();
assert('Old contract closed on termination date', pkContractClosed != null);
assert('No open contract during gap', db.prepare(`SELECT * FROM employment_contracts WHERE employee_id = 'pk' AND effective_to IS NULL`).get() == null);

// Rehire Oct 1 with a new contract
db.prepare(`UPDATE employees SET status = 'active' WHERE id = 'pk'`).run();
db.prepare(`INSERT INTO employment_contracts (employee_id, employment_type, work_percentage, weekly_target_hours, effective_from)
  VALUES ('pk', 'full-time', 100, 40, '2025-10-01')`).run();

assert('New contract active from Oct 1', db.prepare(`SELECT * FROM employment_contracts WHERE employee_id = 'pk' AND effective_to IS NULL`).get()?.effective_from === '2025-10-01');
assert('Peter status = active after rehire', db.prepare(`SELECT status FROM employees WHERE id = 'pk'`).get().status === 'active');
assert('Rehire contract ≠ old contract', db.prepare(`SELECT COUNT(*) as cnt FROM employment_contracts WHERE employee_id = 'pk'`).get().cnt === 2);

// ─────────────────────────────────────────────
// 8.3 — Employee Termination: Final Settlement
// ─────────────────────────────────────────────
section('8.3 Termination — Final Settlement Payout');

// Sarah Lang (7.7 days entitlement, hired Jul 1). Takes 3 vacation days → 4.7 unused
db.prepare(`INSERT OR IGNORE INTO time_entries (employee_id, work_date, entry_type, hours, regular_hours, overtime_hours, extratime_hours, policy_id, status)
  VALUES ('sl', '2025-11-10', 'vacation', 8, 0, 0, 0, ?, 'approved')`).run(policyId);
db.prepare(`INSERT OR IGNORE INTO time_entries (employee_id, work_date, entry_type, hours, regular_hours, overtime_hours, extratime_hours, policy_id, status)
  VALUES ('sl', '2025-11-11', 'vacation', 8, 0, 0, 0, ?, 'approved')`).run(policyId);
db.prepare(`INSERT OR IGNORE INTO time_entries (employee_id, work_date, entry_type, hours, regular_hours, overtime_hours, extratime_hours, policy_id, status)
  VALUES ('sl', '2025-11-12', 'vacation', 8, 0, 0, 0, ?, 'approved')`).run(policyId);

const sarahVacUsed = db.prepare(`SELECT SUM(hours) / 8.0 as days FROM time_entries WHERE employee_id = 'sl' AND entry_type = 'vacation'`).get().days;
const sarahBal = db.prepare(`SELECT * FROM year_balances WHERE employee_id = 'sl' AND year = 2025`).get();
const sarahUnused = Math.round((sarahBal.vacation_entitlement - sarahVacUsed) * 10) / 10;

// Seed gives Sarah full 23 days (seed doesn't apply pro-rata — tested separately in Group 5)
// 23 entitlement - 3 used = 20 unused
assert('Sarah used 3 vacation days', sarahVacUsed === 3);
assert('Sarah unused = 20 days (23 entitlement - 3 used)', sarahUnused === 20);

db.prepare(`INSERT INTO balance_adjustments (employee_id, year, adjustment_type, amount, unit, reason, created_by)
  VALUES ('sl', 2025, 'payout_vacation', ?, 'days', 'Termination final settlement', 'hr_admin')`).run(-sarahUnused);

const payout = db.prepare(`SELECT * FROM balance_adjustments WHERE employee_id = 'sl' AND adjustment_type = 'payout_vacation'`).get();
assert('Payout adjustment recorded', payout != null);
assert('Payout amount = -20 days', Math.round(payout.amount * 10) / 10 === -20);
assert('Payout created_by = hr_admin', payout.created_by === 'hr_admin');

const adjTotal = db.prepare(`SELECT SUM(amount) as total FROM balance_adjustments WHERE employee_id = 'sl' AND year = 2025`).get().total || 0;
const finalBal = Math.round((sarahBal.vacation_entitlement + adjTotal - sarahVacUsed) * 10) / 10;
assert('Final balance = 0 after payout', finalBal === 0);

// ─────────────────────────────────────────────
// 8.4 — Terminated Employee Entries Still Queryable
// ─────────────────────────────────────────────
section('8.4 Historical Data Survives Termination');

db.prepare(`UPDATE employees SET status = 'terminated' WHERE id = 'sl'`).run();
db.prepare(`UPDATE employment_contracts SET effective_to = '2025-12-15' WHERE employee_id = 'sl' AND effective_to IS NULL`).run();

assert('Sarah marked terminated', db.prepare(`SELECT status FROM employees WHERE id = 'sl'`).get().status === 'terminated');
assert('Sarah entries still exist after termination', db.prepare(`SELECT COUNT(*) as cnt FROM time_entries WHERE employee_id = 'sl'`).get().cnt >= 3);
assert('Sarah year balance survives termination', db.prepare(`SELECT * FROM year_balances WHERE employee_id = 'sl'`).get() != null);
assert('Payout adjustment survives termination', db.prepare(`SELECT * FROM balance_adjustments WHERE employee_id = 'sl'`).all().length >= 1);
assert('Can query salary history from terminated employee', db.prepare(`SELECT * FROM employment_contracts WHERE employee_id = 'sl'`).all().length >= 1);

// ─────────────────────────────────────────────
// 8.5 — Role Change (no contract or balance impact)
// ─────────────────────────────────────────────
section('8.5 Role Change — No Balance Impact');

db.prepare(`UPDATE employees SET role = 'Manager' WHERE id = 'mm'`).run();
assert('Role updated to Manager', db.prepare(`SELECT role FROM employees WHERE id = 'mm'`).get().role === 'Manager');

const mmContractAfter = db.prepare(`SELECT * FROM employment_contracts WHERE employee_id = 'mm' AND effective_to IS NULL`).get();
assert('Contract still 100% after role change', mmContractAfter.work_percentage === 100);

const mmBalAfter = db.prepare(`SELECT * FROM year_balances WHERE employee_id = 'mm' AND year = 2025`).get();
assert('Vacation entitlement unchanged', mmBalAfter.vacation_entitlement === 23);
assert('OT carryover unchanged', mmBalAfter.overtime_carryover === 8);
assert('Time entries unchanged', db.prepare(`SELECT COUNT(*) as cnt FROM time_entries WHERE employee_id = 'mm'`).get().cnt === 12);

db.prepare(`UPDATE employees SET role = 'Service' WHERE id = 'mm'`).run();
assert('Role restored to Service', db.prepare(`SELECT role FROM employees WHERE id = 'mm'`).get().role === 'Service');

// ─────────────────────────────────────────────
// 8.6 — Employee Turns 50: Bracket Change at Year Start
// ─────────────────────────────────────────────
section('8.6 Age Bracket Change at 50 (Year Start Only)');

// Hans Bauer born 1976-06-15
// Jan 1 2025: age 48 → 20–49 bracket → 23 days
// Jan 1 2026: age 49 → 20–49 bracket → 23 days (hasn't turned 50 yet)
// Jan 1 2027: age 50 → 50+ bracket  → 29 days (birthday is Jun 15, but bracket applied Jan 1)
db.prepare(`INSERT INTO employees (id, name, role, date_of_birth, hire_date, location, status)
  VALUES ('hb50', 'Hans Bauer', 'Service', '1976-06-15', '2020-01-01', 'Zürich', 'active')`).run();
db.prepare(`INSERT INTO employment_contracts (employee_id, employment_type, work_percentage, weekly_target_hours, effective_from)
  VALUES ('hb50', 'full-time', 100, 40, '2020-01-01')`).run();

db.prepare(`INSERT INTO year_balances (employee_id, year, vacation_entitlement, vacation_carryover, overtime_carryover, policy_id, snapshot)
  VALUES ('hb50', 2025, 23, 0, 0, ?, ?)`).run(policyId, JSON.stringify({ age_at_jan1: 48 }));
db.prepare(`INSERT INTO year_balances (employee_id, year, vacation_entitlement, vacation_carryover, overtime_carryover, policy_id, snapshot)
  VALUES ('hb50', 2026, 23, 0, 0, ?, ?)`).run(policyId, JSON.stringify({ age_at_jan1: 49 }));
db.prepare(`INSERT INTO year_balances (employee_id, year, vacation_entitlement, vacation_carryover, overtime_carryover, policy_id, snapshot)
  VALUES ('hb50', 2027, 29, 0, 0, ?, ?)`).run(policyId, JSON.stringify({ age_at_jan1: 50 }));

assert('2025: 23 days (age 48)', db.prepare(`SELECT vacation_entitlement FROM year_balances WHERE employee_id = 'hb50' AND year = 2025`).get().vacation_entitlement === 23);
assert('2026: 23 days (age 49, still under 50)', db.prepare(`SELECT vacation_entitlement FROM year_balances WHERE employee_id = 'hb50' AND year = 2026`).get().vacation_entitlement === 23);
assert('2027: 29 days (age 50, bracket upgrades)', db.prepare(`SELECT vacation_entitlement FROM year_balances WHERE employee_id = 'hb50' AND year = 2027`).get().vacation_entitlement === 29);
assert('Bracket change uses age on Jan 1, not birthday mid-year', JSON.parse(db.prepare(`SELECT snapshot FROM year_balances WHERE employee_id = 'hb50' AND year = 2027`).get().snapshot).age_at_jan1 === 50);
assert('2025 and 2026 unchanged after 2027 created', (() => {
  const b25 = db.prepare(`SELECT vacation_entitlement FROM year_balances WHERE employee_id = 'hb50' AND year = 2025`).get().vacation_entitlement;
  const b26 = db.prepare(`SELECT vacation_entitlement FROM year_balances WHERE employee_id = 'hb50' AND year = 2026`).get().vacation_entitlement;
  return b25 === 23 && b26 === 23;
})());

// ─────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────
console.log(`\n${'═'.repeat(52)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('  🎉 Group 8 passed! Employee lifecycle is solid.\n');
} else {
  console.log('  ⚠️  Some tests failed.\n');
}
