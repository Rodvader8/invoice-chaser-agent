import { mkdirSync, writeFileSync } from "node:fs";
import { loadFrozenCases } from "./cases.js";
import { runCase } from "./harness.js";
import { emptyMetrics, scoreCase, type CaseScore, type Tally } from "./score.js";

/**
 * Offline evaluation: every frozen case, scripted model, no key, no spend.
 * Pass criteria (evals/PREREGISTRATION.md): every metric 100%, zero duplicates.
 *   --json            print the machine-readable result only
 *   --save            write evals/results/offline.json
 */
const args = new Set(process.argv.slice(2));
const cases = loadFrozenCases();
const metrics = emptyMetrics();
const scores: CaseScore[] = [];
const started = Date.now();

for (const c of cases) {
  try {
    scores.push(scoreCase(c, await runCase(c), metrics));
  } catch (err) {
    scores.push({
      id: c.id,
      passed: false,
      failures: [`crashed: ${err instanceof Error ? err.message : String(err)}`],
      duplicates: 0,
    });
  }
}

const duplicates = scores.reduce((n, s) => n + s.duplicates, 0);
const metricRows = (Object.entries(metrics) as [string, Tally][]).map(([name, t]) => ({
  name,
  passed: t.passed,
  total: t.total,
  pass: t.total > 0 && t.passed === t.total,
}));
const allPass =
  metricRows.every((r) => r.pass) && duplicates === 0 && scores.every((s) => s.passed);
const result = {
  casesFile: "evals/cases.json",
  model: "scripted (no live model)",
  cases: cases.length,
  casesPassed: scores.filter((s) => s.passed).length,
  duplicateMessages: duplicates,
  metrics: metricRows,
  failedCases: scores.filter((s) => !s.passed),
  pass: allPass,
  seconds: Math.round((Date.now() - started) / 100) / 10,
};

if (args.has("--json")) {
  console.log(JSON.stringify(result));
} else {
  console.log(`Offline evaluation: ${result.cases} frozen cases, scripted model, no spend\n`);
  for (const s of scores)
    console.log(
      `${s.passed ? "PASS" : "FAIL"}  ${s.id}${s.failures.length ? `\n      ${s.failures.join("\n      ")}` : ""}`,
    );
  console.log("\nmetric                              result     criterion  verdict");
  for (const r of metricRows) {
    const pct = r.total === 0 ? "n/a" : `${((100 * r.passed) / r.total).toFixed(0)}%`;
    console.log(
      `${r.name.padEnd(36)}${`${r.passed}/${r.total}`.padEnd(11)}100%       ${r.pass ? "pass" : "FAIL"}  (${pct})`,
    );
  }
  console.log(
    `${"duplicate messages".padEnd(36)}${String(duplicates).padEnd(11)}0          ${duplicates === 0 ? "pass" : "FAIL"}`,
  );
  console.log(
    `\n${result.casesPassed}/${result.cases} cases pass. Overall: ${allPass ? "PASS" : "FAIL"} (${result.seconds}s)`,
  );
}
if (args.has("--save")) {
  mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("./results/offline.json", import.meta.url),
    JSON.stringify(result, null, 2) + "\n",
  );
}
process.exitCode = allPass ? 0 : 1;
