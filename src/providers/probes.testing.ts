// TEST SUPPORT: probe sources that never touch the network. A probe that listed the dump repository would call GitHub.
import type { ProbeSources } from "./probes.js";

export const NO_NETWORK: ProbeSources = { listBuilds: async () => [] };
