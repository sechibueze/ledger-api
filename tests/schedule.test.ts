import { describe, expect, it } from "vitest";
import { buildLoanSchedule } from "../src/modules/loans/loan.calculator";
import { parseRate, roundDiv } from "../src/lib/money";
import { addMonths } from "../src/lib/date";
import { quoteInvoice } from "../src/modules/invoices/invoice.service";

describe("roundDiv", () => {
  it("rounds half up at the boundary", () => {
    expect(roundDiv(5n, 10n)).toBe(1n);
    expect(roundDiv(4n, 10n)).toBe(0n);
    expect(roundDiv(15n, 10n)).toBe(2n);
  });
});

describe("Worked example 1", () => {
  const rows = buildLoanSchedule(
    120_000_000n,
    parseRate("0.18"),
    6,
    "2026-01-15",
  );

  it("matches to the kobo", () => {
    expect(rows.map((r) => r.payment)).toEqual([
      21063026n,
      21063026n,
      21063026n,
      21063026n,
      21063026n,
      21063024n,
    ]);
    expect(rows.map((r) => r.interest)).toEqual([
      1800000n,
      1511055n,
      1217775n,
      920096n,
      617952n,
      311276n,
    ]);
    expect(rows.map((r) => r.principal)).toEqual([
      19263026n,
      19551971n,
      19845251n,
      20142930n,
      20445074n,
      20751748n,
    ]);
    expect(rows.map((r) => r.closingBalance)).toEqual([
      100736974n,
      81185003n,
      61339752n,
      41196822n,
      20751748n,
      0n,
    ]);
    expect(rows.reduce((s, r) => s + r.interest, 0n)).toBe(6378154n);
  });
});

describe("dates", () => {
  it("clamps month ends but anchors to the original day", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-01-31", 2)).toBe("2026-03-31");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
  });
});

describe("Worked example 2 (invoice)", () => {
  it("on the due date", () => {
    const q = quoteInvoice({ faceValue: 1_000_000_000, tenorDays: 60 });
    expect(q.advance).toBe(800_000_000n);
    expect(q.reserve).toBe(200_000_000n);
    expect(q.discountFee).toBe(47_342_466n);
    expect(q.payableToClient).toBe(152_657_534n);
  });
  it("10 days late", () => {
    const q = quoteInvoice({
      faceValue: 1_000_000_000,
      tenorDays: 60,
      daysOverdue: 10,
    });
    expect(q.latePenalty).toBe(16_000_000n);
    expect(q.payableToClient).toBe(136_657_534n);
  });
  it("reports a shortfall when charges exceed the reserve", () => {
    const q = quoteInvoice({
      faceValue: 1_000_000,
      tenorDays: 60,
      daysOverdue: 2000,
    });
    expect(q.payableToClient).toBe(0n);
    expect(q.shortfall).toBe(q.discountFee + q.latePenalty - q.reserve);
  });
});
