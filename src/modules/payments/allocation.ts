import { minBig } from "../../lib/money";

export const COMPONENTS = ["penalty", "fee", "interest", "principal"] as const;
export type Comp = Record<(typeof COMPONENTS)[number], bigint>;
export const zeroComp = (): Comp => ({
  penalty: 0n,
  fee: 0n,
  interest: 0n,
  principal: 0n,
});

export interface DueInstalment extends Comp {
  id: string;
  dueDate: string;
}
export interface PaymentInput {
  id: string;
  amount: bigint;
  paymentDate: string;
}
export interface Plan {
  allocations: Map<string, Comp>;
  unapplied: bigint;
}

/**
 * Replays payments (already ordered) against the instalments. Each payment only reaches
 * instalments due on or before its payment date, oldest first. Leftover becomes unapplied credit.
 */
export function computeAllocations(
  instalments: DueInstalment[],
  payments: PaymentInput[],
): Map<string, Plan> {
  const remainingInstalments = instalments.map((instalment) => ({
    ...instalment,
  }));
  const paymentPlans = new Map<string, Plan>();

  for (const payment of payments) {
    let remainingAmount = payment.amount;
    const allocations = new Map<string, Comp>();

    for (const instalment of remainingInstalments) {
      //enforce instalments to be ordered by due date
      if (remainingAmount === 0n || instalment.dueDate > payment.paymentDate)
        break;

      const allocatedComponents = zeroComp();

      for (const component of COMPONENTS) {
        const allocatedAmount = minBig(remainingAmount, instalment[component]);

        allocatedComponents[component] = allocatedAmount;
        instalment[component] -= allocatedAmount;
        remainingAmount -= allocatedAmount;
      }

      if (COMPONENTS.some((component) => allocatedComponents[component] > 0n)) {
        allocations.set(instalment.id, allocatedComponents);
      }
    }

    paymentPlans.set(payment.id, { allocations, unapplied: remainingAmount });
  }

  return paymentPlans;
}
