# HRMS Timesheet Schema — Approach & Design Philosophy

This document explains how we are thinking about and building the HRMS timesheet and leave tracking schema. It is written for anyone joining the project to quickly understand the reasoning behind the design decisions.

---

## The Core Problem We Are Solving

Business rules in any HR system change over time. Overtime thresholds change. Vacation policies switch from age-based to flat. Employees move from full-time to part-time. Public holidays get added or removed.

The dangerous assumption most systems make is that rules are stable. They build systems that store only the current rules and recalculate historical data using those current rules whenever a report is needed. This means the moment a rule changes, you lose the ability to accurately answer: *"What was this employee's overtime in March 2023?"*

**Our goal is simple: no matter what changes, no matter how many years pass, every historical record must remain exactly as accurate as the day it was created.**

---

## The Three Principles We Follow

### 1. Calculate Once, Store Forever

Every time an employee logs hours, we calculate all results immediately — regular hours, overtime, premiums — and store those results alongside the rules that were used. We never recalculate historical data.

If overtime rules change tomorrow, last month's entries are untouched. They already have their answer frozen inside them, along with a record of which rules were applied.

### 2. Rules Are Versioned, Not Replaced

When a business rule changes, we do not update the existing rule. We close it with an end date and create a new version starting from the change date. This means at any point in time, we can look up exactly which rule was active on any given date.

The same applies to employee contracts. If an employee changes from 80% to 60% workload, we close the old contract and open a new one. Both records exist permanently.

### 3. Immutable Records

Once a time entry is approved, it is never changed. If a correction is needed, it is recorded as a new adjustment entry with a reason. This creates a full audit trail of everything that happened and why.

---

## How the Schema Is Structured

The schema has four conceptual layers:

**Layer 1 — The Rules (Policies)**
Company policies store all business rules with version history. Working hours, overtime thresholds, premium rates, vacation brackets, carryover limits — all live here with effective dates. Only one version is active at any given time, but all versions are kept forever.

**Layer 2 — The People (Employees + Contracts)**
Employee master data never changes. Contract changes are tracked as a history of versioned records. At any date, you can query exactly what an employee's contract looked like.

**Layer 3 — What Actually Happened (Time Entries)**
Every working day, absence, vacation day, sick day, and compensation day is a row in the time entries table. For work days, the calculation results are stored immediately at submission time — not computed later. Each entry carries a frozen snapshot: a record of the exact policy rules that were active and how the calculation was done.

**Layer 4 — Annual Standing (Year Balances + Adjustments)**
At the start of each year, a snapshot is created per employee capturing their vacation entitlement, overtime carryover, and vacation carryover for that year. This is the starting point for all balance calculations in that year. Adjustments — manual corrections, payouts, compensation days taken — are stored as separate ledger entries against this balance.

---

## How Vacation Balance Works

Vacation is not accrued monthly. It is granted upfront at the start of each year based on the policy active on January 1. The entitlement is calculated from the employee's age and contract percentage at that point in time and stored in the year balance snapshot.

The remaining vacation at any point is simply:

> Entitlement + Carryover − Days Used This Year + Any Manual Adjustments

Days used are counted by looking at all time entries of type *vacation* for that year. There is no separate running counter that needs to be kept in sync.

---

## The Lazy Initialization Approach (No Cron Jobs)

One design decision we made deliberately is to avoid scheduled background jobs for year-end processing. Instead we use lazy initialization: the year balance for a given year is only created the first time that year's data is actually accessed.

The moment an employee logs their first time entry of a new year, or a manager views that employee's balance, the system checks whether a year balance exists for that year. If it does not, it calculates and stores one on the spot using the active policy on January 1 of that year and the unused balances from the previous year.

After that first calculation, the record exists permanently and is never recalculated.

This approach has several advantages. Background jobs fire for all employees at midnight regardless of who is actually active. Lazy initialization only triggers for employees who are actually being used. There is also no timing risk — if a policy update is saved on December 31, the lazy calculation on January 2 picks it up correctly because it always queries the policy that was active on January 1.

---

## How Policy Changes Affect Things

**Time tracking (overtime, premiums):** Effect is immediate. Any time entry logged after the policy change date uses the new rules. Entries before that date are already stored with their snapshot and are unaffected.

**Vacation entitlement:** Effect is deferred to the next year start. The current year's entitlement was already calculated and stored in the year balance. It does not change. The next year's lazy initialization will pick up the new rules.

**If a mid-year adjustment is explicitly needed** — for example, a policy change that legally requires retroactive entitlement correction — this is handled through a balance adjustment entry. It is explicit, carries a reason, and creates an audit trail. The year balance itself still does not change.

---

## How Workload Changes Affect Things

When an employee changes from full-time to part-time mid-year, a new employment contract row is created from the change date. The old contract is closed.

**For time tracking:** The new weekly target hours apply immediately from the contract change date. Overtime for new entries is calculated against the new threshold. Old entries are frozen and unchanged.

**For vacation:** The current year's entitlement in the year balance does not change. The next year's calculation will use the new work percentage. If a pro-rata adjustment is required, it is added as a balance adjustment entry with an explanation.

---

## What This Gives Us

Years from now, anyone — a manager, an auditor, a developer — can look at any time entry or balance record and understand exactly:

- What the employee did on that day
- How many regular, overtime, and premium hours it produced
- Which exact version of the policy was active
- How the calculation was derived
- What their vacation and overtime balance was at any point in time

No guesswork. No recalculation. No dependency on current rules to understand past records.

---

## Testing Strategy

We are validating the schema through a series of Node.js scripts using SQLite. Each script tests a specific scenario — policy changes, contract changes, year-end rollover, edge cases — by inserting data, triggering the scenario, and asserting that historical records remain accurate.

The test groups cover approximately 90 scenarios across employee lifecycle, policy versioning, premium calculations, vacation tracking, overtime compensation, year-end rollover, and edge cases. The goal is to prove the schema handles every realistic situation before it is used in production.
