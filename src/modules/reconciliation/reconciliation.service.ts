import { db } from "../../database/db";

type LoanRow = {
  loan_id: string;
  sub_loans: bigint;
  sub_interest: bigint;
  sub_unapplied: bigint;
  led_loans: bigint;
  led_interest: bigint;
  led_unapplied: bigint;
};

/**
 * Loan-level balances come from the sub-ledger (instalments, allocations, payments).
 * Ledger balances come from journal lines tagged with the loan id.
 * Control accounts are the whole-ledger totals, including lines that carry no loan id.
 */
export async function reconcile() {
  const loans = await db.$queryRaw<LoanRow[]>`
    SELECT l.id AS loan_id,
      (l.principal - COALESCE(al.principal, 0))::bigint          AS sub_loans,
      (COALESCE(ac.interest, 0) - COALESCE(al.interest, 0))::bigint AS sub_interest,
      COALESCE(un.unapplied, 0)::bigint                           AS sub_unapplied,
      COALESCE(le.loans, 0)::bigint                               AS led_loans,
      COALESCE(le.interest, 0)::bigint                            AS led_interest,
      COALESCE(le.unapplied, 0)::bigint                           AS led_unapplied
    FROM loans l
    LEFT JOIN (SELECT p.loan_id, SUM(a.principal) AS principal, SUM(a.interest) AS interest
               FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
               WHERE p.status = 'APPLIED' GROUP BY p.loan_id) al ON al.loan_id = l.id
    LEFT JOIN (SELECT loan_id, SUM(interest_due) AS interest FROM instalments
               WHERE interest_accrued_at IS NOT NULL GROUP BY loan_id) ac ON ac.loan_id = l.id
    LEFT JOIN (SELECT loan_id, SUM(unapplied) AS unapplied FROM payments
               WHERE status = 'APPLIED' GROUP BY loan_id) un ON un.loan_id = l.id
    LEFT JOIN (SELECT loan_id,
        SUM(CASE WHEN account_code = 'LOANS_RECEIVABLE'    THEN CASE side WHEN 'D' THEN amount ELSE -amount END ELSE 0 END) AS loans,
        SUM(CASE WHEN account_code = 'INTEREST_RECEIVABLE' THEN CASE side WHEN 'D' THEN amount ELSE -amount END ELSE 0 END) AS interest,
        SUM(CASE WHEN account_code = 'UNAPPLIED_CREDIT'    THEN CASE side WHEN 'C' THEN amount ELSE -amount END ELSE 0 END) AS unapplied
        FROM journal_lines WHERE loan_id IS NOT NULL GROUP BY loan_id) le ON le.loan_id = l.id`;

  const control = await db.$queryRaw<
    { account_code: string; balance: bigint }[]
  >`
    SELECT account_code,
      SUM(CASE WHEN account_code = 'UNAPPLIED_CREDIT'
               THEN CASE side WHEN 'C' THEN amount ELSE -amount END   -- liability: credit-normal
               ELSE CASE side WHEN 'D' THEN amount ELSE -amount END END)::bigint AS balance
    FROM journal_lines
    WHERE account_code IN ('LOANS_RECEIVABLE', 'INTEREST_RECEIVABLE', 'UNAPPLIED_CREDIT')
    GROUP BY account_code`;
  const controlOf = (code: string) =>
    control.find((c) => c.account_code === code)?.balance ?? 0n;

  const pairs = [
    {
      account: "LOANS_RECEIVABLE",
      sub: (r: LoanRow) => r.sub_loans,
      led: (r: LoanRow) => r.led_loans,
    },
    {
      account: "INTEREST_RECEIVABLE",
      sub: (r: LoanRow) => r.sub_interest,
      led: (r: LoanRow) => r.led_interest,
    },
    {
      account: "UNAPPLIED_CREDIT",
      sub: (r: LoanRow) => r.sub_unapplied,
      led: (r: LoanRow) => r.led_unapplied,
    },
  ];

  const controlAccounts = pairs.map((p) => {
    const loanLevelTotal = loans.reduce((s, r) => s + p.sub(r), 0n);
    const controlBalance = controlOf(p.account);
    return {
      account: p.account,
      controlBalance,
      loanLevelTotal,
      difference: controlBalance - loanLevelTotal,
    };
  });

  const loanDifferences = loans.flatMap((r) =>
    pairs
      .filter((p) => p.led(r) !== p.sub(r))
      .map((p) => ({
        loanId: r.loan_id,
        account: p.account,
        ledger: p.led(r),
        loanLevel: p.sub(r),
        difference: p.led(r) - p.sub(r),
      })),
  );

  return {
    balanced:
      controlAccounts.every((c) => c.difference === 0n) &&
      loanDifferences.length === 0,
    controlAccounts,
    loanDifferences,
  };
}
