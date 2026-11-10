import { describe, expect, it } from "vitest";
import { computeAllocations } from "../src/modules/payments/allocation";

const inst = (
  id: string,
  dueDate: string,
  interest: bigint,
  principal: bigint,
  penalty = 0n,
  fee = 0n,
) => ({ id, dueDate, interest, principal, penalty, fee });

describe("waterfall", () => {
  const instalments = [
    inst("i1", "2026-02-15", 100n, 900n),
    inst("i2", "2026-03-15", 100n, 900n),
  ];

  it("allocates interest before principal and only to due instalments", () => {
    const plan = computeAllocations(instalments, [
      { id: "p", amount: 500n, paymentDate: "2026-02-15" },
    ]).get("p")!;
    expect(plan.allocations.get("i1")).toEqual({
      penalty: 0n,
      fee: 0n,
      interest: 100n,
      principal: 400n,
    });
    expect(plan.unapplied).toBe(0n);
  });

  it("leaves excess as unapplied credit, not a prepayment on instalment 2", () => {
    const plan = computeAllocations(instalments, [
      { id: "p", amount: 1500n, paymentDate: "2026-02-15" },
    ]).get("p")!;
    expect(plan.allocations.has("i2")).toBe(false);
    expect(plan.unapplied).toBe(500n);
  });

  it("applies penalty, then fee, then interest, then principal", () => {
    const plan = computeAllocations(
      [inst("i1", "2026-02-15", 100n, 900n, 30n, 20n)],
      [{ id: "p", amount: 160n, paymentDate: "2026-02-15" }],
    ).get("p")!;
    expect(plan.allocations.get("i1")).toEqual({
      penalty: 30n,
      fee: 20n,
      interest: 100n,
      principal: 10n,
    });
  });

  it("oldest unpaid first across instalments", () => {
    const plan = computeAllocations(instalments, [
      { id: "p", amount: 1500n, paymentDate: "2026-03-15" },
    ]).get("p")!;
    expect(plan.allocations.get("i1")!.principal).toBe(900n);
    expect(plan.allocations.get("i2")).toEqual({
      penalty: 0n,
      fee: 0n,
      interest: 100n,
      principal: 400n,
    });
  });
});
