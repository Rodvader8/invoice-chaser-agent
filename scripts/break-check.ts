import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Proves the offline evaluation can fail. For each break: copy the repo to a temporary folder,
 * make one change to the code, run the evaluation there, and require it to FAIL in the named
 * cases. An unchanged copy must PASS first (the control). Any break the evaluation misses fails
 * this script. The breaks are the four listed in evals/PREREGISTRATION.md.
 */
interface Break {
  name: string;
  file: string;
  search: string;
  replace: string;
  mustFail: string[];
}

const BREAKS: Break[] = [
  {
    name: "skip the readback after an uncertain send",
    file: "src/send/sender.ts",
    search: "const afterLoss = judgeReadback(await outbox.readback(key), key, hash);",
    replace: 'const afterLoss = judgeReadback({ kind: "not_found" }, key, hash);',
    mustFail: [
      "send-01-reply-lost-after-apply",
      "send-02-503-after-apply",
      "send-04-real-timeout",
      "send-05-readback-fails",
    ],
  },
  {
    name: "ignore payments when computing what's owed",
    file: "src/assess.ts",
    search: "return invoice.totalCents - paid;",
    replace: "return invoice.totalCents;",
    mustFail: [
      "money-03-partial-payment",
      "money-04-float-trap",
      "chase-01-paid-in-full",
      "chase-08-figures-disagree",
    ],
  },
  {
    name: "switch off the payment-details check on drafts",
    file: "src/draft/check.ts",
    search: "reasons.push(...findForeignContactDetails(text, business));",
    replace: "",
    mustFail: ["trap-01-injection-bank-details", "trap-08-injection-redirect-email"],
  },
  {
    name: "fee from more than 30 days instead of 30 or more",
    file: "src/assess.ts",
    search: "days >= RULES.lateFeeAfterDays",
    replace: "days > RULES.lateFeeAfterDays",
    mustFail: ["money-05-fee-boundary-30-days"],
  },
];

interface EvalJson {
  pass: boolean;
  failedCases: { id: string }[];
}

const root = resolve(import.meta.dirname, "..");

function evalIn(dir: string): EvalJson {
  let out: string;
  try {
    out = execFileSync(process.execPath, ["--import", "tsx", "evals/run.ts", "--json"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // A failing evaluation exits 1; its JSON is still on stdout.
    out = (err as { stdout?: string }).stdout ?? "";
  }
  const line = out.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as EvalJson;
}

function copyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "invoice-chaser-break-"));
  for (const part of ["src", "evals", "package.json", "tsconfig.json"]) {
    cpSync(join(root, part), join(dir, part), { recursive: true });
  }
  rmSync(join(dir, "evals/results"), { recursive: true, force: true });
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  return dir;
}

let ok = true;
const control = copyRepo();
try {
  const result = evalIn(control);
  console.log(`control (no change): evaluation ${result.pass ? "passes" : "FAILS"}`);
  if (!result.pass) {
    console.log("  the unchanged code must pass before the breaks mean anything");
    ok = false;
  }
} finally {
  rmSync(control, { recursive: true, force: true });
}

for (const b of BREAKS) {
  const dir = copyRepo();
  try {
    const path = join(dir, b.file);
    const source = readFileSync(path, "utf8");
    const count = source.split(b.search).length - 1;
    if (count !== 1) {
      console.log(
        `BROKEN CHECK  ${b.name}: expected the code to change once, found ${count} matches (the break is out of date)`,
      );
      ok = false;
      continue;
    }
    writeFileSync(path, source.replace(b.search, b.replace));
    const result = evalIn(dir);
    const failed = new Set(result.failedCases.map((c) => c.id));
    const missed = b.mustFail.filter((id) => !failed.has(id));
    const caught = !result.pass && missed.length === 0;
    console.log(
      `${caught ? "CAUGHT" : "MISSED"}  ${b.name}: evaluation ${result.pass ? "passes" : "fails"}, failing cases: ${[...failed].join(", ") || "none"}`,
    );
    if (!caught) {
      if (missed.length > 0)
        console.log(`        expected to fail but didn't: ${missed.join(", ")}`);
      ok = false;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(ok ? "\nBreak check: every break was caught." : "\nBreak check FAILED.");
process.exitCode = ok ? 0 : 1;
