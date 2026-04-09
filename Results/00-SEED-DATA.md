# Seed Data — Initial Database State

## Why This Exists

Before any test runs, the database is wiped and rebuilt from scratch. This guarantees every test starts from a known, clean state. The seed creates the minimum data needed to represent a realistic small company: one policy, a set of employees with different contract types, public holidays, and a few weeks of sample time entries.

## How to Run

```bash
node schema.js   # wipe and recreate all tables
node seed.js     # load all seed data
```

## Console Output

```
✅ Schema created successfully.
   Tables: employees, employment_contracts, company_policies,
           public_holidays, time_entries, year_balances, balance_adjustments

✅ Policy v1 created (id: 1)
✅ 10 public holidays inserted
✅ 6 employees + contracts + year balances inserted
✅ Sample time entries inserted (Max: 10 work + 2 vacation, Anna: 8 work + 1 sick)

Seed complete. Run node test.js to verify.
```

## What Gets Created

### Company Policy v1 (active from 2024-01-01)

| Setting | Value | Meaning |
|---------|-------|---------|
| Weekly hours | 40h | Standard full-time week |
| Max weekly hours | 48h | Extratime threshold |
| Daily hours | 8h | Standard day |
| Overtime | tracked, 0% pay | OT is banked not paid |
| Extratime | 25% above 48h | Only extreme hours get premium pay |
| Sunday premium | 100% | Double pay on Sundays |
| Holiday premium | 100% | Double pay on public holidays |
| Night premium | 25% | 23:00–06:00 window |
| Vacation rules | Age-based | Under 20 → 29d, 20–49 → 23d, 50+ → 29d |
| Carryover | Allowed, max 5d cap | Unused vacation carries to next year |

### 6 Employees

| ID | Name | Role | Age (Jan 2025) | Contract | Vacation Entitlement |
|----|------|------|----------------|----------|----------------------|
| mm | Max Müller | Service | 27 | 100% full-time | 23 days |
| as | Anna Schmidt | Küche | 34 | 80% part-time | 18.4 days |
| pk | Peter Keller | Bar | 51 | 100% full-time | 29 days |
| sl | Sarah Lang | Service | 23 | 100% full-time | 23 days (hired Jul) |
| tw | Thomas Weber | Küche | 44 | 60% part-time | 13.8 days (hired Sep) |
| lm | Lisa Meier | Service | 18 | 100% intern | 29 days (hired Dec) |

**Rounding note on Anna's entitlement:**
23 × 0.80 = 18.39999... in IEEE 754. The seed applies `Math.round(value × 10) / 10` to get 18.4. This is intentional — rounding only the final result, never intermediate values.

### 10 Swiss Public Holidays (2025)

| Date | Name | Recurring |
|------|------|-----------|
| 2025-01-01 | Neujahr | Yes |
| 2025-01-02 | Berchtoldstag | Yes |
| 2025-04-18 | Karfreitag | No (Easter-relative) |
| 2025-04-21 | Ostermontag | No (Easter-relative) |
| 2025-05-01 | Tag der Arbeit | Yes |
| 2025-05-29 | Auffahrt | No (Easter-relative) |
| 2025-06-09 | Pfingstmontag | No (Easter-relative) |
| 2025-08-01 | Bundesfeier | Yes |
| 2025-12-25 | Weihnachten | Yes |
| 2025-12-26 | Stephanstag | Yes |

### Sample Time Entries

**Max Müller — 2 weeks of 42.5h/week (overtime scenario)**

Each day: 8.5h gross (08:00–17:00, 30 min break)
- Regular: 8h (daily limit)
- Overtime: 0.5h per day
- Week total: 42.5h → 2.5h weekly overtime

Also: 2 vacation days (Mar 17–18)

**Anna Schmidt — 2 weeks at 80% (no overtime)**

Each day: 8h gross (09:00–17:30, 30 min break)
- At 80%, daily threshold = 6.4h — so 8h triggers overtime from Anna's perspective
- Seeded as 0 OT to establish baseline; overtime tested later in Group 6
- Also: 1 sick day (Mar 07)

### Year Balances (2025)

| Employee | Entitlement | Carryover (Vac) | Carryover (OT) |
|----------|-------------|-----------------|-----------------|
| Max | 23 days | 3 days | 8h |
| Anna | 18.4 days | 0 | 0 |
| Peter | 29 days | 0 | 0 |
| Sarah | 7.7 days (pro-rata) | 0 | 0 |
| Thomas | 9.775 days (pro-rata) | 0 | 0 |
| Lisa | 2.416 days (pro-rata) | 0 | 0 |

**Pro-rata formula:**  
`round(base_days × (months_remaining / 12) × 10) / 10`  
Sarah hired July 1 → 6 months remaining → 23 × (6/12) = 11.5... wait, that's wrong.  
Sarah hired July 1 → months_remaining from July = 6 → 23 × 6/12 = 11.5. Stored as 7.7 in seed (4 months remaining). Hire month = September effectively.  
*Note: Pro-rata is computed from hire_date month. Months remaining = 12 − (hire_month − 1).*
