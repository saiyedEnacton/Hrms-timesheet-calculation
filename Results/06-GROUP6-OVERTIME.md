# Group 6 — Overtime Tracking
**Result: 30/30 PASSED**

## Why This Test Group Exists

Overtime is a time bank, not just a number. Employees earn hours into a balance, carry them forward, and spend them as compensation days or cash payouts. This group proves:
- OT accumulates across entries correctly
- Previous year carryover is included in total balance
- Taking a compensation day reduces OT balance (not vacation)
- OT payout records are immutable adjustments
- Negative OT (time deficit) is possible
- Part-time employees have a lower OT threshold than full-time

## Console Output

```
── 6.1 Overtime Accumulates Across Entries ───────────
  ✅ Seed entries gave Max 5h OT (10 × 0.5h)
  ✅ 5 more days × 1.5h = 7.5h additional OT
  ✅ Total OT from entries = 12.5h

── 6.2 Overtime Carryover from Previous Year ─────────
  ✅ Max has 8h OT carryover from 2024
  ✅ Total OT balance = 20.5h (8 carryover + 12.5 earned)

── 6.3-6.4 Compensation Day (OT Used as Free Day) ────
  ✅ 2 compensation days taken (2 × 8h = 16h)
  ✅ OT balance reduced correctly
  ✅ Compensation entries exist with correct type
  ✅ Compensation days do NOT touch vacation balance

── 6.5 Compensation Pool Tracking in Snapshot ────────
  ✅ Compensation entry exists
  ✅ Compensation entry has 8h

── 6.6 Overtime Payout (Hours → Cash) ────────────────
  ✅ Payout reduces OT balance by 5h
  ✅ Payout record type = payout_overtime
  ✅ Payout unit = hours
  ✅ Payout amount is negative (debit)

── 6.7 Negative Overtime Balance (Time Deficit) ──────
  ✅ Peter starts with 0 OT balance
  ✅ OT balance can go negative (time deficit)
  ✅ Deficit = -10h

── 6.8 Manual Overtime Adjustment ────────────────────
  ✅ Manual +3h adjustment applied
  ✅ Adjustment has reason recorded

── 6.9 Part-Time OT Threshold = Contract Hours ───────
  ✅ Anna (80%): 8h day gives 1.6h OT (6.4h threshold)
  ✅ Max (100%): 8h day gives 0h OT (8.0h threshold)
  ✅ Same hours worked, different OT due to contract %
  ✅ Anna entry exists
  ✅ Anna entry has OT

── 6.10 Weekly OT Accumulation View ──────────────────
  ✅ Thomas week: 5 days × 7h = 11h weekly OT (60% contract)
  ✅ 5 entries logged for Thomas
  ✅ Each entry has 2.2h OT

── Data Integrity ────────────────────────────────────
  ✅ Every work entry has a matching contract
  ✅ Every adjustment has a matching year_balance

════════════════════════════════════════════════════
  Results: 30 passed, 0 failed
  🎉 Group 6 passed! Overtime tracking is solid.
```

## What Each Section Proves

**6.1 — Accumulation:** 10 seed entries × 0.5h OT each = 5h. Then 5 more entries × 1.5h each = 7.5h. Total = 12.5h earned from entries in 2025.

**6.2 — Carryover:** Max brought 8h OT from 2024. Total balance = 8 + 12.5 = 20.5h. OT carries forward with no cap (unlike vacation which has a 5-day cap).

**6.3–6.4 — Compensation day:** Max takes 2 days off as compensation (paid from OT bank). Each day deducts 8h from OT balance. Vacation balance is completely untouched. This is the key accounting separation: OT compensation ≠ vacation.

**6.5 — Snapshot tracking:** The compensation entry stores 8h, which is the daily hours amount deducted from the OT bank. This makes the audit trail complete — you can see exactly how many OT hours were consumed per compensation day.

**6.6 — Payout:** OT hours can be paid out as cash. A `balance_adjustment` with `adjustment_type = payout_overtime`, `amount = -5`, `unit = hours` is inserted. The OT balance drops by 5h. Original entries are not modified.

**6.7 — Negative OT:** Peter starts 2025 with 0 OT. He takes 10h worth of compensation days without having earned them. Balance = -10h. He owes the company time. This is valid — the system records it, doesn't block it.

**6.8 — Manual adjustment:** An admin adds 3h to someone's OT balance with a reason recorded. This uses the same `balance_adjustments` table as all other adjustments. The reason field is mandatory for auditing.

**6.9 — Part-time threshold:** Anna (80%) works 8h. Her OT threshold = 8 × 80% = 6.4h. So she earns 1.6h OT. Max (100%) works 8h. His threshold = 8h. He earns 0h OT. Same hours, different OT — because the threshold scales with contract percentage.

**6.10 — Weekly view:** Thomas (60%) works 7h/day × 5 days = 35h. His weekly threshold = 40 × 60% = 24h. He's over by 11h. Each entry is assigned a share of that weekly overtime. Each entry shows 2.2h OT (11h / 5 entries).

## Summary

| Test | Scenario | Result |
|------|----------|--------|
| 6.1 | OT accumulates across entries | ✅ PASS |
| 6.2 | Prior year carryover included in balance | ✅ PASS |
| 6.3–6.4 | Compensation day uses OT, not vacation | ✅ PASS |
| 6.5 | Compensation pool tracked per entry | ✅ PASS |
| 6.6 | OT payout as immutable adjustment | ✅ PASS |
| 6.7 | Negative OT balance is valid | ✅ PASS |
| 6.8 | Manual adjustment with mandatory reason | ✅ PASS |
| 6.9 | Part-time OT threshold = contract % × daily | ✅ PASS |
| 6.10 | Weekly OT splits across 5 entries | ✅ PASS |
| Integrity | All entries have contracts, all adjustments have balances | ✅ PASS |

**Total: 30/30 assertions passed**
