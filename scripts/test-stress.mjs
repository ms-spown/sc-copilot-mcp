// Runs the test suite under artificial CPU load, to flush out tests that depend on real time, sockets or file-system
// timing. Local use only, NOT part of CI. See "Running the suite under load" in CONTRIBUTING.md.
//
//   npm run test:stress                         # 3 rounds, 4 suites at once, one CPU burner per logical core
//   npm run test:stress -- --rounds 10 --parallel 6 --burners 16 --workers 8
//
// Each round starts `--parallel` full vitest runs at the same time (each with its own temp folder, so they do not
// share a cache), plus `--burners` busy-loop processes that keep the CPU saturated. A round passes when every run
// passes. The summary lists the tests that failed and how many runs they failed in. Exit code 1 if any run failed.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`--${name} needs a non-negative integer`);
    process.exit(2);
  }
  return n;
}

// `--only a b` (last on the line): run just the test files whose path contains a or b, instead of the whole suite.
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt === -1 ? [] : process.argv.slice(onlyAt + 1);
const rounds = arg("rounds", 3);
const parallel = Math.max(1, arg("parallel", 4));
const burners = arg("burners", os.cpus().length);
// Workers per suite: vitest starts one per core by default, which with several suites at once is hundreds of node
// processes and a machine that swaps (a memory problem, not the CPU load this script is about).
const workers = Math.max(2, arg("workers", Math.floor(os.cpus().length / parallel)));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "sc-stress-"));
const vitestBin = path.join(root, "node_modules", "vitest", "vitest.mjs");

const burnerCode = "const e=Date.now()+36e5;while(Date.now()<e){Math.sqrt(Math.random())}";
const burnerProcs = Array.from({ length: burners }, () =>
  spawn(process.execPath, ["-e", burnerCode], { stdio: "ignore" }),
);
const stopBurners = () => burnerProcs.forEach((p) => p.kill());
process.on("exit", stopBurners);
process.on("SIGINT", () => process.exit(130));

// First informative line. A test that hits its timeout is reported by vitest as an "Error: STACK_TRACE_ERROR"
// placeholder with the runner's own stack (no message), so say what it is; an assertion keeps its own message.
function firstLine(text, durationMs) {
  const all = String(Array.isArray(text) ? text.join("\n") : (text ?? ""));
  if (all.includes("STACK_TRACE_ERROR"))
    return `TIMEOUT (the test ran ${Math.round(durationMs ?? 0)} ms)`;
  return (
    all
      .split(/[\r\n]/)
      .map((l) => l.trim())
      .find((l) => l !== "")
      ?.slice(0, 160) ?? ""
  );
}
const counts = new Map();
const firstMessage = new Map();

function runOnce(round, index) {
  const tag = `r${round}-p${index}`;
  const tmp = path.join(work, tag);
  const report = path.join(work, `${tag}.json`);
  fs.mkdirSync(tmp, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        vitestBin,
        "run",
        `--maxWorkers=${workers}`,
        "--reporter=json",
        `--outputFile=${report}`,
        ...only,
      ],
      {
        cwd: root,
        // Own temp folder per run: concurrent suites must not share the cache folder that vitest.config.ts derives
        // from os.tmpdir().
        env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
        stdio: "ignore",
      },
    );
    child.on("exit", (code) => {
      const failed = [];
      try {
        const json = JSON.parse(fs.readFileSync(report, "utf8"));
        for (const file of json.testResults) {
          const rel = path.relative(root, file.name).replaceAll("\\", "/");
          if (
            file.status === "failed" &&
            file.assertionResults.every((a) => a.status !== "failed")
          ) {
            failed.push(`${rel} :: ${firstLine(file.message) || "file-level failure"}`);
          }
          for (const a of file.assertionResults) {
            if (a.status !== "failed") continue;
            const name = `${rel} :: ${a.fullName}`;
            failed.push(name);
            if (!firstMessage.has(name))
              firstMessage.set(name, firstLine(a.failureMessages, a.duration));
          }
        }
      } catch {
        if (code !== 0) failed.push("(no readable report: the run crashed)");
      }
      resolve({ tag, code, failed });
    });
  });
}

let runs = 0;
let failedRuns = 0;
const started = Date.now();
for (let round = 1; round <= rounds; round++) {
  const results = await Promise.all(
    Array.from({ length: parallel }, (_, i) => runOnce(round, i + 1)),
  );
  for (const r of results) {
    runs++;
    if (r.code !== 0 || r.failed.length > 0) failedRuns++;
    for (const f of new Set(r.failed)) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const bad = results.filter((r) => r.code !== 0 || r.failed.length > 0).length;
  console.log(`round ${round}/${rounds}: ${results.length - bad}/${results.length} runs passed`);
}
stopBurners();

console.log(
  `\n${runs - failedRuns}/${runs} runs passed under load (${parallel} suites at once with ${workers} workers each, ${burners} burners, ` +
    `${Math.round((Date.now() - started) / 1000)} s).`,
);
if (counts.size > 0) {
  console.log("Failures (number of runs it failed in):");
  for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n}x  ${name}`);
    if (firstMessage.has(name)) console.log(`        ${firstMessage.get(name)}`);
  }
}
fs.rmSync(work, { recursive: true, force: true });
process.exit(failedRuns > 0 ? 1 : 0);
