import { execFile } from "node:child_process";

/**
 * The user-level environment variables of the machine, behind an interface so that nothing but the real
 * command ever touches the real ones: tests use a memory store.
 */
export interface EnvStore {
  /** The persistent USER value, or null when the variable is not set. Never the inherited process value. */
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** Runs a PowerShell script; `extraEnv` reaches it as environment variables. Returns stdout. */
export type PowerShellRunner = (
  script: string,
  extraEnv: Record<string, string>,
) => Promise<string>;

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const VALUE = /^[A-Za-z0-9_.-]{0,64}$/;

const ABSENT = "<ABSENT>";

/**
 * Windows implementation: `[Environment]::SetEnvironmentVariable(name, value, 'User')`, which also broadcasts the
 * change to running programs. No `setx` (it truncates at 1024 characters) and no hand-written registry access.
 * Name and value go in through the child's environment, never into the script text, so nothing is interpolated.
 */
export class WindowsUserEnvStore implements EnvStore {
  constructor(private readonly run: PowerShellRunner = runPowerShell) {}

  async get(name: string): Promise<string | null> {
    assertName(name);
    const out = await this.run(
      `$v = [Environment]::GetEnvironmentVariable($env:SCT_NAME, 'User'); if ($null -eq $v) { [Console]::Out.Write('${ABSENT}') } else { [Console]::Out.Write('SET:' + $v) }`,
      { SCT_NAME: name },
    );
    const text = out.trim();
    if (text === ABSENT) return null;
    if (text.startsWith("SET:")) return text.slice(4);
    throw new Error("Could not read the user environment variable (unexpected PowerShell output).");
  }

  async set(name: string, value: string): Promise<void> {
    assertName(name);
    if (!VALUE.test(value)) throw new Error("Refusing an unusual environment variable value.");
    await this.run(`[Environment]::SetEnvironmentVariable($env:SCT_NAME, $env:SCT_VALUE, 'User')`, {
      SCT_NAME: name,
      SCT_VALUE: value,
    });
  }

  async remove(name: string): Promise<void> {
    assertName(name);
    await this.run(`[Environment]::SetEnvironmentVariable($env:SCT_NAME, $null, 'User')`, {
      SCT_NAME: name,
    });
  }
}

function assertName(name: string): void {
  if (!NAME.test(name)) throw new Error("Refusing an unusual environment variable name.");
}

export const runPowerShell: PowerShellRunner = (script, extraEnv) =>
  new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { env: { ...process.env, ...extraEnv }, timeout: 20_000, windowsHide: true },
      (error, stdout) => {
        if (error) reject(new Error(`PowerShell failed: ${error.message.split("\n")[0]}`));
        else resolve(stdout);
      },
    );
  });
