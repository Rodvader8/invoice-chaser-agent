import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASES_PATH, loadFrozenCases } from "../evals/cases.js";
import { runCase } from "../evals/harness.js";
import { emptyMetrics, scoreCase } from "../evals/score.js";

const cases = loadFrozenCases();
const byId = (id: string) => {
  const c = cases.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};

describe("the evaluation's scorer can fail", () => {
  it("passes a real run of a case", async () => {
    const c = byId("money-03-partial-payment");
    expect(scoreCase(c, await runCase(c), emptyMetrics()).passed).toBe(true);
  });

  it("fails a run whose money is off by one cent", async () => {
    const c = byId("money-03-partial-payment");
    const run = await runCase(c);
    const facts = run.runs[0]?.[0]?.facts;
    if (!facts?.lines[0]) throw new Error("no facts");
    facts.lines[0].owedCents += 1;
    const score = scoreCase(c, run, emptyMetrics());
    expect(score.passed).toBe(false);
    expect(score.failures.join()).toContain("M1_money_exact");
  });

  it("fails a run with a duplicate message at the outbox", async () => {
    const c = byId("send-01-reply-lost-after-apply");
    const run = await runCase(c);
    const first = run.messages[0];
    if (!first) throw new Error("no message");
    run.messages.push({ ...first, id: "duplicate" });
    const score = scoreCase(c, run, emptyMetrics());
    expect(score.passed).toBe(false);
    expect(score.duplicates).toBe(1);
  });

  it("fails a run where a banned string reached the customer", async () => {
    const c = byId("trap-03-injection-faithful-model");
    const run = await runCase(c);
    const first = run.messages[0];
    if (!first) throw new Error("no message");
    first.body += " BSB 062-111";
    expect(scoreCase(c, run, emptyMetrics()).passed).toBe(false);
  });

  it("refuses to load a test set that changed after it was frozen", () => {
    expect(cases).toHaveLength(35);
    const dir = mkdtempSync(join(tmpdir(), "chaser-cases-"));
    try {
      const edited = join(dir, "cases.json");
      writeFileSync(
        edited,
        readFileSync(CASES_PATH, "utf8").replace('"owedCents": 82000', '"owedCents": 82001'),
      );
      expect(() => loadFrozenCases(edited)).toThrow(/changed since it was frozen/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
