import { assert, describe, it } from "@effect/vitest";

import {
  buildLaunchdPlist,
  buildLaunchdWrapperScript,
  parseLaunchdServiceState,
  parseSystemdServiceState,
  resolveSupervisorKind,
} from "./rebounce.ts";

describe("rebounce", () => {
  describe("resolveSupervisorKind", () => {
    it("uses systemd on linux", () => {
      assert.equal(resolveSupervisorKind("linux"), "systemd");
    });

    it("uses launchd on macOS", () => {
      assert.equal(resolveSupervisorKind("darwin"), "launchd");
    });

    it("rejects unsupported platforms", () => {
      assert.throws(() => resolveSupervisorKind("win32"), /supports Linux \(systemd\) and macOS/);
    });
  });

  describe("service state parsing", () => {
    it("parses systemd state", () => {
      const state = parseSystemdServiceState(`MainPID=4242
ActiveEnterTimestamp=Thu 2026-04-23 11:42:19 CDT
`);

      assert.deepStrictEqual(state, {
        mainPid: 4242,
        stateToken: "Thu 2026-04-23 11:42:19 CDT",
      });
    });

    it("parses launchd state", () => {
      const state = parseLaunchdServiceState(`gui/501/dev.justin.t3code = {
	state = running
	runs = 7
	pid = 793
	last exit code = (never exited)
}
`);

      assert.deepStrictEqual(state, {
        mainPid: 793,
        stateToken: "running|7|(never exited)",
      });
    });
  });

  describe("launchd assets", () => {
    it("renders a wrapper script with optional TLS setup", () => {
      const script = buildLaunchdWrapperScript({
        baseDir: "/Users/justin/.t3code-service",
        homeDir: "/Users/justin",
        logDir: "/Users/justin/Library/Logs/t3code-service",
        nodeBinary: "/opt/homebrew/bin/node",
        pathEnv: "/Users/justin/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin",
        port: "3773",
        repoRoot: "/Users/justin/git/github/t3code",
        serverHost: "0.0.0.0",
      });

      assert.include(script, 'export HOME="/Users/justin"');
      assert.include(
        script,
        'TAILSCALE_BIN="${T3CODE_REBOUNCE_TAILSCALE_BINARY:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}"',
      );
      assert.include(script, 'exec "/opt/homebrew/bin/node" "$REPO_DIR/apps/server/dist/bin.mjs"');
      assert.include(script, '--base-dir "$BASE_DIR"');
    });

    it("renders a launch agent plist with environment variables", () => {
      const plist = buildLaunchdPlist({
        environmentVariables: {
          HOME: "/Users/justin",
          PATH: "/Users/justin/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin",
          T3CODE_REBOUNCE_TLS_DOMAIN: "case.wirehair-wall.ts.net",
        },
        label: "dev.justin.t3code",
        launcherPath: "/Users/justin/.local/bin/t3code-run",
        stderrPath: "/Users/justin/Library/Logs/t3code-service/launchd.stderr.log",
        stdoutPath: "/Users/justin/Library/Logs/t3code-service/launchd.stdout.log",
        workingDirectory: "/Users/justin/git/github/t3code",
      });

      assert.include(plist, "<string>dev.justin.t3code</string>");
      assert.include(plist, "<string>/Users/justin/.local/bin/t3code-run</string>");
      assert.include(plist, "<key>T3CODE_REBOUNCE_TLS_DOMAIN</key>");
      assert.include(plist, "<string>case.wirehair-wall.ts.net</string>");
    });
  });
});
