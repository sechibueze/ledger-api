import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/database/db";
import { api, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(() => db.$disconnect());

const createEntry = (lines: any[], date = "2026-02-01") =>
  api().post("/ledger/entries").send({ date, description: "test", lines });

const balancedLines = [
  { account: "CASH", side: "D", amount: 500 },
  { account: "FEE_INCOME", side: "C", amount: 500 },
];

describe("ledger API", () => {
  it("posts a balanced entry and shows it in the trial balance", async () => {
    expect((await createEntry(balancedLines)).status).toBe(201);

    const trialBalance = (await api().get("/ledger/trial-balance")).body.data;

    expect(trialBalance.balanced).toBe(true);
    expect(
      trialBalance.accounts.find((account: any) => account.code === "CASH")
        .netBalance,
    ).toBe(500);
  });

  it("rejects unbalanced, single-line, float and non-positive amounts", async () => {
    expect(
      (
        await createEntry([
          { ...balancedLines[0] },
          { ...balancedLines[1], amount: 499 },
        ])
      ).status,
    ).toBe(422);

    expect((await createEntry([balancedLines[0]])).status).toBe(400);

    expect(
      (
        await createEntry([
          { ...balancedLines[0], amount: 10.5 },
          balancedLines[1],
        ])
      ).status,
    ).toBe(400);

    expect(
      (
        await createEntry([
          { ...balancedLines[0], amount: 0 },
          balancedLines[1],
        ])
      ).status,
    ).toBe(400);
  });

  it("reverses once, links the reversal, and rejects a second reversal", async () => {
    const originalEntry = (await createEntry(balancedLines)).body.data;

    const firstReversal = await api()
      .post(`/ledger/entries/${originalEntry.id}/reverse`)
      .send({});

    expect(firstReversal.status).toBe(201);
    expect(firstReversal.body.data.reversesEntryId).toBe(originalEntry.id);
    expect(
      firstReversal.body.data.lines.find((line: any) => line.account === "CASH")
        .side,
    ).toBe("C");

    expect(
      (await api().post(`/ledger/entries/${originalEntry.id}/reverse`).send({}))
        .status,
    ).toBe(409);

    const trialBalance = (await api().get("/ledger/trial-balance")).body.data;

    expect(
      trialBalance.accounts.find((account: any) => account.code === "CASH")
        .netBalance,
    ).toBe(0);
  });

  it("concurrent reversals produce exactly one reversing entry", async () => {
    const originalEntry = (await createEntry(balancedLines)).body.data;

    const reversalResponses = await Promise.all(
      Array.from({ length: 10 }, () =>
        api().post(`/ledger/entries/${originalEntry.id}/reverse`).send({}),
      ),
    );

    expect(
      reversalResponses.filter((response) => response.status === 201),
    ).toHaveLength(1);

    expect(
      await db.journalEntry.count({
        where: { reversesEntryId: originalEntry.id },
      }),
    ).toBe(1);
  });
});

describe("database-level guards (bypassing the app code)", () => {
  const insertEntryDirectly = (
    lines: { account: string; side: string; amount: bigint }[],
  ) =>
    db.$transaction(async (transaction) => {
      const journalEntry = await transaction.journalEntry.create({
        data: {
          entryDate: new Date("2026-02-01"),
          description: "x",
          kind: "MANUAL",
        },
      });

      await transaction.journalLine.createMany({
        data: lines.map((line) => ({
          entryId: journalEntry.id,
          accountCode: line.account,
          side: line.side,
          amount: line.amount,
        })),
      });

      return journalEntry;
    });

  it("rejects an unbalanced entry at commit", async () => {
    await expect(
      insertEntryDirectly([
        { account: "CASH", side: "D", amount: 100n },
        { account: "FEE_INCOME", side: "C", amount: 99n },
      ]),
    ).rejects.toThrow();

    expect(await db.journalEntry.count()).toBe(0);
  });

  it("rejects an entry with a single line", async () => {
    await expect(
      insertEntryDirectly([{ account: "CASH", side: "D", amount: 100n }]),
    ).rejects.toThrow();
  });

  it("rejects zero and negative line amounts", async () => {
    await expect(
      insertEntryDirectly([
        { account: "CASH", side: "D", amount: 0n },
        { account: "FEE_INCOME", side: "C", amount: 0n },
      ]),
    ).rejects.toThrow();
  });

  it("rejects UPDATE and DELETE on entries and lines", async () => {
    const originalEntry = (await createEntry(balancedLines)).body.data;

    await expect(
      db.$executeRaw`
        UPDATE journal_lines
        SET amount = 1
        WHERE entry_id = ${originalEntry.id}::uuid
      `,
    ).rejects.toThrow();

    await expect(
      db.$executeRaw`
        DELETE FROM journal_lines
        WHERE entry_id = ${originalEntry.id}::uuid
      `,
    ).rejects.toThrow();

    await expect(
      db.$executeRaw`
        UPDATE journal_entries
        SET description = 'x'
        WHERE id = ${originalEntry.id}::uuid
      `,
    ).rejects.toThrow();

    await expect(
      db.$executeRaw`
        DELETE FROM journal_entries
        WHERE id = ${originalEntry.id}::uuid
      `,
    ).rejects.toThrow();
  });
});
