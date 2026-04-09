# Group 4 — Premium Calculations
**Result: 67/67 PASSED**

## Why This Test Group Exists

Premium pay (Sunday, holiday, night shift) is legally required in Swiss employment law and must be calculated correctly even years after the fact. This group proves that:
- Each premium type triggers correctly based on the date and time
- Multiple premiums can stack on the same entry (Sunday + holiday + night)
- When premium rates change via a policy update, old entries keep their original hours recorded — they do NOT get recalculated

## Test Cases and Output

---

### 4.1 — Regular Weekday, Zero Premiums
**Question:** Does a plain Monday 9-to-5 correctly show zero premium hours?

```
── 4.1 Regular Weekday — Zero Premiums ───────────────
  ✅ Entry created
  ✅ Gross hours = 8h
  ✅ Regular hours = 8h (at daily limit)
  ✅ Overtime = 0
  ✅ Sunday premium = 0
  ✅ Holiday premium = 0
  ✅ Night premium = 0
```

**What this proves:** Baseline — normal work generates no premium charges. If this fails, every other premium test is meaningless.

---

### 4.2 — Sunday Premium
**Question:** Does working on a Sunday correctly flag all hours as Sunday premium?

```
── 4.2 Sunday Premium ────────────────────────────────
  ✅ 2025-03-16 is Sunday
  ✅ Entry created
  ✅ Gross hours = 8.5h
  ✅ Regular = 8h
  ✅ Overtime = 0.5h (v1 daily>8h)
  ✅ Sunday premium = 8.5h (all gross hours)
  ✅ Holiday premium = 0 (not a holiday)
  ✅ Night premium = 0 (day shift)
```

**What this proves:** Sunday premium applies to ALL hours worked that day including overtime. The full 8.5h is eligible for premium, not just the regular 8h.

---

### 4.3 — Public Holiday Premium (Tag der Arbeit, May 1)
**Question:** Does working on a Swiss public holiday correctly flag all hours as holiday premium?

```
── 4.3 Public Holiday Premium (Tag der Arbeit) ───────
  ✅ 2025-05-01 is in public_holidays table
  ✅ Entry created
  ✅ Gross hours = 8.5h
  ✅ Holiday premium = 8.5h (all gross hours)
  ✅ Sunday premium = 0 (Thursday)
  ✅ Night premium = 0
```

**What this proves:** Holiday is a separate premium from Sunday. May 1 is a Thursday, so Sunday premium is 0 but holiday premium is the full gross hours.

---

### 4.4 — Night Shift Premium (23:00–06:00 window)
**Question:** Does a night shift entry correctly calculate only the hours that fall inside the 23:00–06:00 window?

```
── 4.4 Night Shift Premium (23:00–06:00 window) ──────
  ✅ Entry created (spans midnight)
  ✅ Gross hours = 9h
  ✅ Regular = 8h (v1 daily_hours)
  ✅ Overtime = 1h (9 − 8)
  ✅ Night premium = 7h (23:00–06:00 overlap)
  ✅ Sunday premium = 0 (Monday)
  ✅ Holiday premium = 0
  ✅ calcNightHours("22:00","07:00") = 7
  ✅ calcNightHours("08:00","17:00") = 0 (day)
  ✅ calcNightHours("23:00","06:00") = 7 (full)
```

**What this proves:** Night premium is calculated as the overlap between actual work hours and the night window. An entry from 22:00–07:00 crosses midnight; only the 7 hours inside 23:00–06:00 count as night premium. Day shifts get 0.

---

### 4.5 — Stacked Premiums: Sunday + Holiday + Night (all three at once)
**Question:** Can a single entry qualify for all three premiums simultaneously?

```
── 4.5 Stacked: Sunday + Holiday + Night (all three) ────
  ✅ 2025-04-06 is Sunday
  ✅ Test holiday exists on 2025-04-06
  ✅ Entry created
  ✅ Gross = 9h
  ✅ Sunday premium = 9h (all hours)
  ✅ Holiday premium = 9h (all hours)
  ✅ Night premium = 7h (23:00–06:00)
```

**What this proves:** All three premiums stack. Sunday = 9h, Holiday = 9h, Night = 7h on the same entry. The payroll system must multiply each against its respective rate independently.

---

### 4.6 — Holiday + Overtime (Bundesfeier, August 1)
**Question:** When someone works overtime on a public holiday, do both the overtime and the holiday premium apply to the full gross hours?

```
── 4.6 Holiday + Overtime (policy threshold, Bundesfeier 2025-08-01) ────
  ✅ Entry created
  ✅ Entry references active policy
  ✅ Gross hours = 9.5h
  ✅ Regular = 8h (active daily_hours)
  ✅ Overtime = 1.5h (9.5 − 8)
  ✅ Holiday premium = 9.5h (ALL gross hours, incl OT)
  ✅ Sunday premium = 0 (Friday)
  ✅ Night premium = 0 (day shift)
```

**What this proves:** Holiday premium is not capped at regular hours. The overtime portion (1.5h) is also eligible for holiday premium because the law covers all hours worked on a holiday.

---

### 4.7 — Extratime (weekly hours exceeding 48h max)
**Question:** When a week's total exceeds 48h, are those extreme hours tracked as a separate extratime category?

```
── 4.7 Extratime — 50h/week Exceeds 48h Max Threshold ────
  ✅ 5 entries inserted for the week
  ✅ Weekly gross total = 50h
  ✅ Weekly regular sum = 40h (5 × 8)
  ✅ Weekly true OT (40–48h) = 8h
  ✅ Weekly extratime (>48h) = 2h
  ✅ Policy max_weekly_hours = 48 (v1)
  ✅ Extratime premium rate = 25% in policy
```

**What this proves:** Three tiers exist — regular (0–40h), overtime (40–48h), extratime (48h+). Extratime gets a 25% premium. This is separate from Sunday/holiday/night premiums.

---

### 4.8 — Rate Change: Historical Snapshots Preserved
**Question:** If premium rates change (e.g. Sunday rate goes from 100% to 150%), do old entries remain at the original rate?

```
── 4.8 Rate Change — Historical Snapshots Preserved ────
  ✅ Old Sunday entry exists (from 4.2)
  ✅ Old entry: policy_id references v1
  ✅ Old entry: sunday premium = 8.5h
  ✅ 2025-10-05 is Sunday
  ✅ New entry created under v3
  ✅ New entry references v3 policy
  ✅ New entry: sunday premium = 8.5h (same hours)
  ✅ Old entry STILL references v1 policy
  ✅ Old entry STILL has 8.5h sunday premium
  ✅ Both entries have premium hours, policy_id differs
```

**What this proves:** Old entries are never touched when policy changes. Both entries have the same 8.5h of Sunday hours, but they reference different policy versions. The actual rate percentage (100% vs 150%) lives in the policy row — payroll multiplies hours × rate at report time, using the policy_id from each entry.

---

## Summary

| Test | Scenario | Result |
|------|----------|--------|
| 4.1 | Regular weekday — zero premiums | ✅ PASS |
| 4.2 | Sunday premium on all gross hours | ✅ PASS |
| 4.3 | Public holiday premium (Thursday) | ✅ PASS |
| 4.4 | Night shift — overlap calculation | ✅ PASS |
| 4.5 | All three premiums stacked | ✅ PASS |
| 4.6 | Holiday + overtime together | ✅ PASS |
| 4.7 | Extratime tier above 48h/week | ✅ PASS |
| 4.8 | Policy rate change, old entries frozen | ✅ PASS |

**Total: 67/67 assertions passed**
