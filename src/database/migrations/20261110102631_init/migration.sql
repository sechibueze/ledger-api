-- CreateTable
CREATE TABLE "accounts" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL,
    "entry_date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reference" TEXT,
    "reverses_entry_id" UUID,
    "loan_id" UUID,
    "payment_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "account_code" TEXT NOT NULL,
    "side" CHAR(1) NOT NULL,
    "amount" BIGINT NOT NULL,
    "loan_id" UUID,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loans" (
    "id" UUID NOT NULL,
    "principal" BIGINT NOT NULL,
    "rate_num" BIGINT NOT NULL,
    "rate_den" BIGINT NOT NULL,
    "annual_rate" TEXT NOT NULL,
    "term_months" INTEGER NOT NULL,
    "disbursement_date" DATE NOT NULL,
    "instalment_amount" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instalments" (
    "id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "due_date" DATE NOT NULL,
    "principal_due" BIGINT NOT NULL,
    "interest_due" BIGINT NOT NULL,
    "penalty_due" BIGINT NOT NULL DEFAULT 0,
    "fee_due" BIGINT NOT NULL DEFAULT 0,
    "interest_accrued_at" TIMESTAMP(3),

    CONSTRAINT "instalments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "amount" BIGINT NOT NULL,
    "payment_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "external_ref" TEXT,
    "unapplied" BIGINT NOT NULL DEFAULT 0,
    "journal_entry_id" UUID,
    "reversed_at" TIMESTAMP(3),
    "reverse_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "instalment_id" UUID NOT NULL,
    "penalty" BIGINT NOT NULL DEFAULT 0,
    "fee" BIGINT NOT NULL DEFAULT 0,
    "interest" BIGINT NOT NULL DEFAULT 0,
    "principal" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocation_audit" (
    "id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "trigger_payment_id" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "journal_entry_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "allocation_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "periods" (
    "period" TEXT NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "periods_pkey" PRIMARY KEY ("period")
);

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reverses_entry_id_key" ON "journal_entries"("reverses_entry_id");

-- CreateIndex
CREATE INDEX "journal_entries_entry_date_idx" ON "journal_entries"("entry_date");

-- CreateIndex
CREATE INDEX "journal_entries_loan_id_idx" ON "journal_entries"("loan_id");

-- CreateIndex
CREATE INDEX "journal_lines_entry_id_idx" ON "journal_lines"("entry_id");

-- CreateIndex
CREATE INDEX "journal_lines_account_code_idx" ON "journal_lines"("account_code");

-- CreateIndex
CREATE INDEX "journal_lines_loan_id_idx" ON "journal_lines"("loan_id");

-- CreateIndex
CREATE UNIQUE INDEX "instalments_loan_id_number_key" ON "instalments"("loan_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "payments_loan_id_seq_key" ON "payments"("loan_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "payments_loan_id_external_ref_key" ON "payments"("loan_id", "external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocations_payment_id_instalment_id_key" ON "payment_allocations"("payment_id", "instalment_id");

-- CreateIndex
CREATE INDEX "allocation_audit_loan_id_idx" ON "allocation_audit"("loan_id");

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses_entry_id_fkey" FOREIGN KEY ("reverses_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_code_fkey" FOREIGN KEY ("account_code") REFERENCES "accounts"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instalments" ADD CONSTRAINT "instalments_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_instalment_id_fkey" FOREIGN KEY ("instalment_id") REFERENCES "instalments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===== Chart of accounts =====
INSERT INTO accounts (code, name, type) VALUES
 ('CASH','Cash','ASSET'),
 ('LOANS_RECEIVABLE','Loans Receivable','ASSET'),
 ('INTEREST_RECEIVABLE','Interest Receivable','ASSET'),
 ('INVOICE_RECEIVABLES','Invoice Receivables','ASSET'),
 ('CLIENT_RECEIVABLE','Client Receivable','ASSET'),
 ('INTEREST_INCOME','Interest Income','INCOME'),
 ('FEE_INCOME','Fee Income','INCOME'),
 ('PENALTY_INCOME','Penalty Income','INCOME'),
 ('CLIENT_PAYABLE','Client Payable','LIABILITY'),
 ('UNAPPLIED_CREDIT','Unapplied Credit','LIABILITY');

 -- ===== CHECK constraints (all money is integer kobo) =====
ALTER TABLE accounts ADD CONSTRAINT accounts_type_valid CHECK (type IN ('ASSET','LIABILITY','INCOME'));
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_amount_positive CHECK (amount > 0);
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_side_valid CHECK (side IN ('D','C'));
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_no_self_reversal CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id);
ALTER TABLE loans ADD CONSTRAINT loans_valid CHECK (principal > 0 AND instalment_amount > 0 AND term_months > 0 AND rate_num >= 0 AND rate_den > 0);
ALTER TABLE instalments ADD CONSTRAINT instalments_nonneg CHECK (principal_due >= 0 AND interest_due >= 0 AND penalty_due >= 0 AND fee_due >= 0);
ALTER TABLE payments ADD CONSTRAINT payments_amounts CHECK (amount > 0 AND unapplied >= 0 AND unapplied <= amount);
ALTER TABLE payments ADD CONSTRAINT payments_status_valid CHECK (status IN ('APPLIED','REVERSED'));
ALTER TABLE payment_allocations ADD CONSTRAINT allocations_nonneg CHECK (penalty >= 0 AND fee >= 0 AND interest >= 0 AND principal >= 0);

-- ===== Balanced entries: deferred constraint triggers =====
CREATE FUNCTION check_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid uuid; d bigint; c bigint; n int;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN eid := NEW.id; ELSE eid := NEW.entry_id; END IF;
  SELECT COALESCE(SUM(amount) FILTER (WHERE side = 'D'), 0),
         COALESCE(SUM(amount) FILTER (WHERE side = 'C'), 0),
         COUNT(*)
    INTO d, c, n FROM journal_lines WHERE entry_id = eid;
  IF n < 2 THEN
    RAISE EXCEPTION 'ENTRY_TOO_FEW_LINES: entry % has % line(s)', eid, n;
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'ENTRY_UNBALANCED: entry % debits % <> credits %', eid, d, c;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

-- ===== Append-only =====
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_IMMUTABLE: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END $$;

CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER allocation_audit_immutable BEFORE UPDATE OR DELETE ON allocation_audit
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ===== Closed periods reject new entries =====
CREATE FUNCTION forbid_closed_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM periods WHERE period = to_char(NEW.entry_date, 'YYYY-MM')) THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: period % is closed', to_char(NEW.entry_date, 'YYYY-MM');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entries_period_open BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_closed_period();