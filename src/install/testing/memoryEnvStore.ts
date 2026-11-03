import type { EnvStore } from "../envStore.js";

/** A stand-in for the user environment, for tests: nothing here can reach the real variables. */
export class MemoryEnvStore implements EnvStore {
  readonly calls: string[] = [];
  constructor(readonly values: Map<string, string> = new Map()) {}

  async get(name: string): Promise<string | null> {
    this.calls.push(`get ${name}`);
    return this.values.get(name) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    this.calls.push(`set ${name}`);
    this.values.set(name, value);
  }
  async remove(name: string): Promise<void> {
    this.calls.push(`remove ${name}`);
    this.values.delete(name);
  }
  get writes(): string[] {
    return this.calls.filter((c) => !c.startsWith("get "));
  }
}
