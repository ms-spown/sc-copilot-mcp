import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILES,
  DOWNLOAD_HOST,
  TUNNEL_ASSETS,
  TUNNEL_CLIENT_VERSION,
  checkApiKey,
  checkPort,
  checkTunnelId,
  childEnv,
  commandPath,
  isTunnelClientVariable,
  mcpCommand,
  PathError,
  renderProfile,
  selectAsset,
} from "./chatgptTunnel.js";

const ID = "tunnel_0123456789abcdef0123456789abcdef";

describe("Feature: the pinned tunnel-client release", () => {
  it("Given the table, Then every asset is the official zip of this version on the one host, with a SHA-256", () => {
    expect(TUNNEL_ASSETS).toHaveLength(6);
    for (const a of TUNNEL_ASSETS) {
      const u = new URL(a.url);
      expect(u.protocol).toBe("https:");
      expect(u.hostname).toBe(DOWNLOAD_HOST);
      expect(u.pathname).toBe(
        `/tunnel-client/v${TUNNEL_CLIENT_VERSION}/tunnel-client-v${TUNNEL_CLIENT_VERSION}-${a.os}-${a.arch}.zip`,
      );
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.size).toBeGreaterThan(1_000_000);
    }
    expect(new Set(TUNNEL_ASSETS.map((a) => a.sha256)).size).toBe(6);
  });

  it("Given the Windows x64 asset, Then its SHA-256 is the one measured on 2026-11-06", () => {
    expect(selectAsset("win32", "x64")?.sha256).toBe(
      "1d0ecc3a54f2a51e27a635ac155f40fbb95df58c52cdeddf6c75532cc0bbeb25",
    );
  });

  it.each([
    ["win32", "x64", "windows", "amd64"],
    ["win32", "arm64", "windows", "arm64"],
    ["linux", "x64", "linux", "amd64"],
    ["linux", "arm64", "linux", "arm64"],
    ["darwin", "x64", "darwin", "amd64"],
    ["darwin", "arm64", "darwin", "arm64"],
  ])("Given %s/%s, When the asset is chosen, Then it is %s-%s", (platform, arch, os, a) => {
    const asset = selectAsset(platform, arch);
    expect(asset?.os).toBe(os);
    expect(asset?.arch).toBe(a);
  });

  it.each([
    ["win32", "ia32"],
    ["linux", "arm"],
    ["freebsd", "x64"],
    ["aix", "ppc64"],
  ])("Given %s/%s, When the asset is chosen, Then there is none", (platform, arch) => {
    expect(selectAsset(platform, arch)).toBeNull();
  });
});

describe("Feature: what the player types is checked", () => {
  it.each([ID, "tunnel_ab12_0123456789abcdef0123456789abcdef", `  ${ID}\n`])(
    "Given the tunnel ID %j, When checked, Then it is accepted (trimmed)",
    (raw) => {
      expect(checkTunnelId(raw)).toEqual({ id: raw.trim() });
    },
  );

  it.each([
    "tunnel_0123456789ABCDEF0123456789abcdef",
    "tunnel_0123",
    "tunnel_abcde_0123456789abcdef0123456789abcdef",
    "0123456789abcdef0123456789abcdef",
    `${ID}"; rm -rf /`,
    "",
  ])("Given the tunnel ID %j, When checked, Then it is refused", (raw) => {
    expect(checkTunnelId(raw)).toHaveProperty("error");
  });

  it("Given an API key pasted as tunnel ID, Then the message says which value goes where", () => {
    const r = checkTunnelId("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect("error" in r && r.error).toMatch(/API key/);
    expect(JSON.stringify(r)).not.toContain("abcdefghijklmnop");
  });

  it("Given a runtime key, When checked, Then it is accepted, trimmed", () => {
    expect(checkApiKey("  sk-proj-AbC_def-0123456789xyz\r\n")).toEqual({
      key: "sk-proj-AbC_def-0123456789xyz",
    });
  });

  it.each([
    ["empty", ""],
    ["an admin key", "sk-admin-0123456789abcdefghij"],
    ["the tunnel ID", ID],
    ["a space inside", "sk-proj-0123456789 abcdefghij"],
    ["too short", "sk-123"],
    ["a non-ASCII letter", "sk-proj-0123456789abcdefgh\u00e9"],
  ])(
    "Given %s, When checked as a key, Then it is refused and the message does not repeat it",
    (_w, raw) => {
      const r = checkApiKey(raw);
      expect(r).toHaveProperty("error");
      if (raw.length > 8) expect(JSON.stringify(r)).not.toContain(raw.slice(6, 20));
    },
  );

  it("Given a key without the sk- prefix, Then it is kept with a warning that does not repeat it", () => {
    const r = checkApiKey("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(r).toMatchObject({ key: "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" });
    expect("warning" in r && r.warning).not.toContain("ABCDEFGHIJ");
  });

  it("Given ports, When checked, Then only 1024 to 65535 pass", () => {
    expect(checkPort("8090")).toEqual({ port: 8090 });
    for (const bad of ["80", "70000", "abc", "8080;", ""])
      expect(checkPort(bad)).toHaveProperty("error");
  });
});

describe("Feature: the profile survives tunnel-client's shell-style split (backslashes are eaten)", () => {
  const winInput = {
    tunnelId: ID,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    entryPath: "C:\\Users\\Jos\u00e9 M\u00fcller\\Jeux\\sc-copilot-mcp\\dist\\index.js",
    keyFile:
      "C:\\Users\\Jos\u00e9 M\u00fcller\\AppData\\Local\\sc-copilot-mcp\\chatgpt\\control-plane-api-key",
    port: 8080,
    platform: "win32",
  };

  it("Given Windows paths with spaces and a non-ASCII user name, When the profile is written, Then each path is quoted with forward slashes", () => {
    const yaml = renderProfile(winInput);
    expect(yaml).toContain(
      'command: "\\"C:/Program Files/nodejs/node.exe\\" \\"C:/Users/Jos\u00e9 M\u00fcller/Jeux/sc-copilot-mcp/dist/index.js\\""',
    );
    expect(yaml).toContain(
      'api_key: "file:C:/Users/Jos\u00e9 M\u00fcller/AppData/Local/sc-copilot-mcp/chatgpt/control-plane-api-key"',
    );
    expect(yaml).toContain(`tunnel_id: "${ID}"`);
    expect(yaml).toContain('listen_addr: "127.0.0.1:8080"');
    // The only backslashes left are the YAML escapes of the quotes around each path.
    expect(yaml.replace(/\\"/g, "")).not.toContain("\\");
  });

  it("Given the command line, When split the way tunnel-client splits it, Then node and the entry come back whole", () => {
    const line = mcpCommand(winInput);
    const parts = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    expect(parts).toEqual([
      "C:/Program Files/nodejs/node.exe",
      "C:/Users/Jos\u00e9 M\u00fcller/Jeux/sc-copilot-mcp/dist/index.js",
    ]);
  });

  it("Given the profile, Then it has no secret, the readable log format and no remote UI or raw HTTP logging", () => {
    const yaml = renderProfile(winInput);
    expect(yaml).not.toMatch(/sk-|allow_remote_ui|http_raw|env:/i);
    expect(yaml).toContain("format: struct-text");
    expect(yaml).toContain("level: warn");
    expect(yaml).toContain("open_browser: false");
    expect(yaml.endsWith("\n")).toBe(true);
  });

  it("Given POSIX paths, When the profile is written, Then they stay as they are, quoted", () => {
    const yaml = renderProfile({
      ...winInput,
      platform: "linux",
      nodePath: "/usr/local/bin/node",
      entryPath: "/home/jos\u00e9/My Games/sc-copilot-mcp/dist/index.js",
      keyFile: "/home/jos\u00e9/.local/share/sc-copilot-mcp/chatgpt/control-plane-api-key",
    });
    expect(yaml).toContain(
      'command: "\\"/usr/local/bin/node\\" \\"/home/jos\u00e9/My Games/sc-copilot-mcp/dist/index.js\\""',
    );
  });

  it.each([
    ["a double quote", '/home/a"b/index.js'],
    ["a backslash", "/home/a\\b/index.js"],
    ["a dollar sign", "/home/$USER/index.js"],
    ["a backtick", "/home/a`b/index.js"],
    ["a new line", "/home/a\nb/index.js"],
  ])("Given a POSIX path with %s, When quoted for tunnel-client, Then it is refused", (_w, p) => {
    expect(() => commandPath(p, "linux")).toThrow(PathError);
  });

  it("Given a malformed tunnel ID, When the profile is written, Then nothing is produced", () => {
    expect(() => renderProfile({ ...winInput, tunnelId: 'tunnel_x"\nmcp:' })).toThrow(PathError);
  });
});

describe("Feature: the environment handed to tunnel-client and to the server", () => {
  const base = {
    PATH: "C:\\Windows",
    CONTROL_PLANE_API_KEY: "sk-should-not-pass-0000000000",
    CONTROL_PLANE_TUNNEL_ID: "tunnel_other",
    OPENAI_API_KEY: "sk-general-0000000000000000",
    openai_admin_key: "sk-admin-000000000000000000",
    LOG_HTTP_RAW_UNSAFE: "true",
    ALLOW_REMOTE_UI: "1",
    MCP_COMMAND: "evil",
    HEALTH_LISTEN_ADDR: ":8080",
    TUNNEL_CLIENT_CONFIG: "other.yaml",
    SC_INSTALL_DIR: "D:\\StarCitizen\\LIVE",
    UNDEFINED_ONE: undefined,
  };

  it("Given the player's environment, When the child's is built, Then every tunnel-client setting and every OpenAI key is removed, by name only", () => {
    const { env, removed } = childEnv(base, {});
    for (const name of [
      "CONTROL_PLANE_API_KEY",
      "CONTROL_PLANE_TUNNEL_ID",
      "OPENAI_API_KEY",
      "openai_admin_key",
      "LOG_HTTP_RAW_UNSAFE",
      "ALLOW_REMOTE_UI",
      "MCP_COMMAND",
      "HEALTH_LISTEN_ADDR",
      "TUNNEL_CLIENT_CONFIG",
    ]) {
      expect(env[name], name).toBeUndefined();
      expect(removed).toContain(name);
    }
    expect(JSON.stringify(removed)).not.toContain("sk-");
    expect(env.PATH).toBe("C:\\Windows");
    expect(env.SC_INSTALL_DIR).toBe("D:\\StarCitizen\\LIVE");
    expect("UNDEFINED_ONE" in env).toBe(false);
  });

  it("Given no option, Then the server gets the installer's profiles and the player's SC_* as they are", () => {
    const { env, set } = childEnv({ SC_TELEMETRY: "on", SC_BALANCE: "hidden" }, {});
    expect(env).toMatchObject({
      SC_TELEMETRY: "on",
      SC_BALANCE: "hidden",
      SCMCP_PROFILES: DEFAULT_PROFILES,
    });
    expect(set).toEqual([`SCMCP_PROFILES=${DEFAULT_PROFILES}`]);
  });

  it("Given --telemetry on, --balance hidden and --profiles core, Then they become SC_TELEMETRY, SC_BALANCE and SCMCP_PROFILES", () => {
    const { env, set } = childEnv(
      { sc_balance: "shown", SCMCP_PROFILES: "core,trade" },
      { telemetry: "on", balance: "hidden", profiles: "core" },
    );
    expect(env.SC_TELEMETRY).toBe("on");
    expect(env.SC_BALANCE).toBe("hidden");
    expect(env.sc_balance).toBeUndefined();
    expect(env.SCMCP_PROFILES).toBe("core");
    expect(set).toEqual(["SC_TELEMETRY=on", "SC_BALANCE=hidden", "SCMCP_PROFILES=core"]);
  });

  it("Given --telemetry off, Then SC_TELEMETRY is removed even if the player had it on", () => {
    const { env } = childEnv({ SC_TELEMETRY: "on" }, { telemetry: "off" });
    expect(env.SC_TELEMETRY).toBeUndefined();
  });

  it("Given the player's own SCMCP_PROFILES, Then it is kept", () => {
    expect(childEnv({ SCMCP_PROFILES: "core" }, {}).env.SCMCP_PROFILES).toBe("core");
  });

  it("Given the names this server reads, Then none is taken for a tunnel-client setting", () => {
    for (const n of [
      "SC_TELEMETRY",
      "SC_BALANCE",
      "SCMCP_PROFILES",
      "UEXTOKEN",
      "LOCALAPPDATA",
      "APPDATA",
      "PATH",
    ])
      expect(isTunnelClientVariable(n), n).toBe(false);
  });
});
