// Use this server from ChatGPT through OpenAI's Secure MCP Tunnel (tunnel-client). Guide: docs/CHATGPT.md.
//
//   npm run chatgpt -- setup --tunnel-id tunnel_...   download the pinned tunnel-client (SHA-256 checked), write its profile
//   npm run chatgpt -- setup --tunnel-id tunnel_... --dry-run   show what it would do, change nothing
//   npm run chatgpt -- key                            paste the runtime API key (nothing is shown)
//   npm run chatgpt -- start [--balance hidden] [--telemetry on]   run the tunnel; keep the window open
//   npm run chatgpt -- doctor | status | help
//
// The logic is in src/install/chatgptCli.ts (dist/install/). This script only wires the real machine in.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!fs.existsSync(path.join(root, "dist", "index.js"))) {
  console.error("dist/index.js is missing. Run: npm ci --ignore-scripts && npm run build");
  console.error("(If Claude Desktop runs this server from this folder, quit it before building.)");
  process.exit(1);
}
const load = (rel) => import(pathToFileURL(path.join(root, "dist", rel)).href);
const { parseArgs, runChatgpt, USAGE } = await load("install/chatgptCli.js");
const { downloadPinned } = await load("install/tunnelDownload.js");
const { readSecret } = await load("install/secretPrompt.js");
const { probeLoopbackPort } = await load("install/portProbe.js");
const { userChatGptDir } = await load("core/paths.js");

const argv = process.argv.slice(2);

// Without "--", npm keeps the options for itself (as npm_config_* variables) and they never reach this script.
const swallowed = ["tunnel_id", "port", "dry_run", "remove", "telemetry", "balance", "profiles"].filter(
  (name) => process.env[`npm_config_${name}`] !== undefined && !argv.includes(`--${name.replace(/_/g, "-")}`),
);
if (swallowed.length > 0) {
  console.error('npm kept the options for itself: put "--" after "npm run chatgpt", for example:');
  console.error("  npm run chatgpt -- setup --tunnel-id tunnel_...");
  process.exit(2);
}

const args = parseArgs(argv);
if ("error" in args) {
  console.error(`${args.error}\n`);
  console.error(USAGE.join("\n"));
  process.exit(2);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// tunnel-client gets the terminal. Ctrl+C reaches it directly (same console on Windows, same process group
// elsewhere); this process only waits for it to stop, and kills it if it does not within 15 seconds or on a second Ctrl+C.
function exec(file, execArgs, env) {
  return new Promise((resolve) => {
    const child = spawn(file, execArgs, { stdio: "inherit", env, windowsHide: false });
    let interrupts = 0;
    let timer = null;
    const onInterrupt = () => {
      interrupts += 1;
      if (interrupts === 1) {
        console.error("\nStopping the tunnel...");
        timer = setTimeout(() => child.kill(), 15_000);
        timer.unref();
      } else child.kill();
    };
    const onHangup = () => child.kill();
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onHangup);
    process.on("SIGHUP", onHangup);
    const done = (code) => {
      if (timer) clearTimeout(timer);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onHangup);
      process.off("SIGHUP", onHangup);
      resolve(code);
    };
    child.once("error", (error) => {
      console.error(`Could not run ${file}: ${error.message}`);
      done(1);
    });
    child.once("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}

let lastShown = -1;
const progress = (received, total) => {
  const tenth = Math.floor((received / total) * 10);
  if (tenth !== lastShown) {
    lastShown = tenth;
    process.stdout.write(`  ${Math.round(received / 1048576)} / ${Math.round(total / 1048576)} MB\n`);
  }
};

const code = await runChatgpt(args, {
  platform: process.platform,
  arch: process.arch,
  home: userChatGptDir(),
  repoRoot: root,
  nodePath: process.execPath,
  env: process.env,
  pid: process.pid,
  download: (asset) => downloadPinned(asset, { progress }),
  readSecret: (prompt) => readSecret(process.stdin, process.stdout, prompt),
  probe: probeLoopbackPort,
  isAlive,
  exec,
  now: () => new Date(),
  out: (line) => console.log(line),
}).catch((error) => {
  console.error(`Failed: ${error.message}`);
  return 1;
});
process.exit(code);
