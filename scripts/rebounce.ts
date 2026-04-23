#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFile, chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SupervisorKind = "systemd" | "launchd";

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface ServiceState {
  readonly mainPid: number;
  readonly stateToken: string;
}

interface LaunchdWrapperOptions {
  readonly baseDir: string;
  readonly homeDir: string;
  readonly logDir: string;
  readonly nodeBinary: string;
  readonly pathEnv: string;
  readonly port: string;
  readonly repoRoot: string;
  readonly serverHost: string;
}

interface LaunchdPlistOptions {
  readonly environmentVariables: Readonly<Record<string, string>>;
  readonly label: string;
  readonly launcherPath: string;
  readonly stderrPath: string;
  readonly stdoutPath: string;
  readonly workingDirectory: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const homeDir = homedir();
const defaultBaseDir = resolve(homeDir, ".t3code-service");
const baseDir = trimEnv("T3CODE_REBOUNCE_BASE_DIR") || defaultBaseDir;
const defaultPathEnv =
  process.env.PATH?.trim() ||
  `${resolve(homeDir, ".bun", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
const bunBinary =
  trimEnv("T3CODE_REBOUNCE_BUN_BINARY") ||
  trimEnv("BUN_BINARY") ||
  (process.execPath.includes("bun") ? process.execPath : "bun");
const runtimeLogsDir = resolve(baseDir, "userdata", "logs");
const healthUrl = trimEnv("T3CODE_REBOUNCE_HEALTH_URL") || "https://127.0.0.1:3773/";
const healthTimeoutMs = Number(process.env.T3CODE_REBOUNCE_TIMEOUT_MS ?? 60_000);
const logPath = trimEnv("T3CODE_REBOUNCE_LOG_PATH") || resolve(runtimeLogsDir, "rebounce.log");
const pollIntervalMs = 1_000;
const isWorker = process.env.T3CODE_REBOUNCE_WORKER === "1";
const supervisorKind = resolveSupervisorKind(process.platform);
const serviceName = trimEnv("T3CODE_REBOUNCE_SERVICE") || resolveDefaultServiceName(supervisorKind);
const serverHost = trimEnv("T3CODE_REBOUNCE_HOST") || "0.0.0.0";
const serverPort = trimEnv("T3CODE_REBOUNCE_PORT") || "3773";

const launchdDomain =
  supervisorKind === "launchd" ? resolveLaunchdDomain() : "gui/unsupported-platform";
const launchdLauncherPath =
  trimEnv("T3CODE_REBOUNCE_LAUNCHER_PATH") || resolve(homeDir, ".local", "bin", "t3code-run");
const launchdPlistPath =
  trimEnv("T3CODE_REBOUNCE_PLIST_PATH") ||
  resolve(homeDir, "Library", "LaunchAgents", `${serviceName}.plist`);
const launchdLogDir =
  trimEnv("T3CODE_REBOUNCE_LAUNCHD_LOG_DIR") ||
  resolve(homeDir, "Library", "Logs", "t3code-service");
const launchdStdoutPath = resolve(launchdLogDir, "launchd.stdout.log");
const launchdStderrPath = resolve(launchdLogDir, "launchd.stderr.log");

export function resolveSupervisorKind(platform: NodeJS.Platform): SupervisorKind {
  if (platform === "linux") return "systemd";
  if (platform === "darwin") return "launchd";
  throw new Error(`rebounce supports Linux (systemd) and macOS (launchd); received ${platform}.`);
}

export function parseSystemdServiceState(stdout: string): ServiceState {
  let mainPid = 0;
  let stateToken = "";

  for (const line of stdout.trim().split("\n")) {
    if (line.startsWith("MainPID=")) {
      mainPid = Number(line.slice("MainPID=".length));
      continue;
    }
    if (line.startsWith("ActiveEnterTimestamp=")) {
      stateToken = line.slice("ActiveEnterTimestamp=".length);
    }
  }

  return { mainPid, stateToken };
}

export function parseLaunchdServiceState(stdout: string): ServiceState {
  const mainPid = Number(stdout.match(/^\s*pid = (\d+)/m)?.[1] ?? 0);
  const state = stdout.match(/^\s*state = ([^\n]+)/m)?.[1]?.trim() ?? "";
  const runs = stdout.match(/^\s*runs = (\d+)/m)?.[1] ?? "";
  const lastExitCode = stdout.match(/^\s*last exit code = ([^\n]+)/m)?.[1]?.trim() ?? "";

  return {
    mainPid,
    stateToken: `${state}|${runs}|${lastExitCode}`,
  };
}

export function buildLaunchdWrapperScript(options: LaunchdWrapperOptions): string {
  const escapedHomeDir = escapeShellDoubleQuoted(options.homeDir);
  const escapedPathEnv = escapeShellDoubleQuoted(options.pathEnv);
  const escapedRepoRoot = escapeShellDoubleQuoted(options.repoRoot);
  const escapedBaseDir = escapeShellDoubleQuoted(options.baseDir);
  const escapedLogDir = escapeShellDoubleQuoted(options.logDir);
  const escapedNodeBinary = escapeShellDoubleQuoted(options.nodeBinary);
  const escapedServerHost = escapeShellDoubleQuoted(options.serverHost);
  const escapedServerPort = escapeShellDoubleQuoted(options.port);

  return `#!/bin/zsh

set -euo pipefail

export HOME="${escapedHomeDir}"
export PATH="${escapedPathEnv}"

REPO_DIR="${escapedRepoRoot}"
BASE_DIR="${escapedBaseDir}"
LOG_DIR="${escapedLogDir}"
SERVER_HOST="${escapedServerHost}"
SERVER_PORT="${escapedServerPort}"

mkdir -p "$BASE_DIR" "$LOG_DIR"
cd "$REPO_DIR"

if [[ -n "\${T3CODE_REBOUNCE_TLS_DOMAIN:-}" ]]; then
  TAILSCALE_BIN="\${T3CODE_REBOUNCE_TAILSCALE_BINARY:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}"
  CERT_DIR="\${T3CODE_REBOUNCE_TLS_CERT_DIR:-$HOME/.config/dev-certs}"
  CERT_DOMAIN="$T3CODE_REBOUNCE_TLS_DOMAIN"
  CERT_FILE="\${T3CODE_REBOUNCE_TLS_CERT_PATH:-$CERT_DIR/$CERT_DOMAIN.crt}"
  KEY_FILE="\${T3CODE_REBOUNCE_TLS_KEY_PATH:-$CERT_DIR/$CERT_DOMAIN.key}"

  mkdir -p "$CERT_DIR"
  "$TAILSCALE_BIN" cert \\
    --min-validity 720h \\
    --cert-file "$CERT_FILE" \\
    --key-file "$KEY_FILE" \\
    "$CERT_DOMAIN"

  export T3CODE_TLS_CERT_PATH="$CERT_FILE"
  export T3CODE_TLS_KEY_PATH="$KEY_FILE"
elif [[ -n "\${T3CODE_REBOUNCE_TLS_CERT_PATH:-}" && -n "\${T3CODE_REBOUNCE_TLS_KEY_PATH:-}" ]]; then
  export T3CODE_TLS_CERT_PATH="$T3CODE_REBOUNCE_TLS_CERT_PATH"
  export T3CODE_TLS_KEY_PATH="$T3CODE_REBOUNCE_TLS_KEY_PATH"
fi

exec "${escapedNodeBinary}" "$REPO_DIR/apps/server/dist/bin.mjs" \\
  --host "$SERVER_HOST" \\
  --port "$SERVER_PORT" \\
  --base-dir "$BASE_DIR" \\
  --no-browser \\
  "$REPO_DIR"
`;
}

export function buildLaunchdPlist(options: LaunchdPlistOptions): string {
  const environmentEntries = Object.entries(options.environmentVariables)
    .map(
      ([key, value]) =>
        `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(options.label)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(options.launcherPath)}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
${environmentEntries}
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ProcessType</key>
  <string>Background</string>

  <key>WorkingDirectory</key>
  <string>${escapeXml(options.workingDirectory)}</string>

  <key>StandardOutPath</key>
  <string>${escapeXml(options.stdoutPath)}</string>

  <key>StandardErrorPath</key>
  <string>${escapeXml(options.stderrPath)}</string>
</dict>
</plist>
`;
}

async function main(): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, "");
  await logLine(`rebounce starting in ${repoRoot}`);
  await logLine(`supervisor: ${supervisorKind}`);
  await logLine(`log: ${logPath}`);
  await logLine(`service: ${serviceName}`);
  await logLine(`health: ${healthUrl}`);

  await ensureServiceSetup();
  const beforeRestart = await readServiceState();
  await logLine(
    `pre-restart service state: pid=${beforeRestart.mainPid} token=${beforeRestart.stateToken}`,
  );

  logStep(`Building web bundle`);
  await runCommand(bunBinary, ["run", "--cwd", "apps/web", "build"], { stdio: "inherit" });

  logStep(`Building server bundle`);
  await runCommand(bunBinary, ["run", "--cwd", "apps/server", "build"], { stdio: "inherit" });

  const artifactPaths = [
    resolve(repoRoot, "apps/server/dist/index.mjs"),
    resolve(repoRoot, "apps/server/dist/client/index.html"),
  ] as const;
  const artifacts = await Promise.all(
    artifactPaths.map(async (path) => ({
      path,
      mtime: (await stat(path)).mtime,
    })),
  );

  logStep(`Restarting ${serviceName}`);
  await restartService();

  logStep(`Waiting for ${serviceName} to come back`);
  const restartedState = await waitForServiceRestart(beforeRestart, healthTimeoutMs);

  logStep(`Waiting for ${healthUrl} to return 200`);
  await waitForHealthy(healthTimeoutMs);

  console.log("");
  console.log(`rebounce complete`);
  console.log(`service: ${serviceName}`);
  console.log(`pid: ${restartedState.mainPid}`);
  console.log(`token: ${restartedState.stateToken}`);
  console.log(`log: ${logPath}`);
  await logLine(`rebounce complete`);
  await logLine(
    `post-restart service state: pid=${restartedState.mainPid} token=${restartedState.stateToken}`,
  );
  for (const artifact of artifacts) {
    console.log(`artifact: ${artifact.path} @ ${artifact.mtime.toISOString()}`);
    await logLine(`artifact: ${artifact.path} @ ${artifact.mtime.toISOString()}`);
  }
}

async function launchWorker(): Promise<void> {
  if (supervisorKind !== "systemd") {
    throw new Error("rebounce workers are only used on Linux/systemd.");
  }

  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, "");
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("rebounce requires numeric uid/gid support on this platform.");
  }

  const unit = `t3code-rebounce-${Date.now()}`;
  const result = await runCommand(
    "sudo",
    [
      "systemd-run",
      "--collect",
      `--unit=${unit}`,
      `--uid=${uid}`,
      `--gid=${gid}`,
      `--property=WorkingDirectory=${repoRoot}`,
      `--setenv=T3CODE_REBOUNCE_WORKER=1`,
      `--setenv=T3CODE_REBOUNCE_LOG_PATH=${logPath}`,
      process.execPath,
      scriptPath,
    ],
    { stdio: "pipe" },
  );

  console.log(`rebounce started`);
  console.log(`unit: ${unit}`);
  console.log(`log: ${logPath}`);
  if (result.stdout.trim().length > 0) {
    console.log(result.stdout.trim());
  }
}

async function ensureServiceSetup(): Promise<void> {
  if (supervisorKind !== "launchd") {
    return;
  }

  const launcherExists = await pathExists(launchdLauncherPath);
  const plistExists = await pathExists(launchdPlistPath);
  if (launcherExists && plistExists) {
    await logLine(`reusing existing launchd setup: ${launchdPlistPath}`);
    return;
  }

  const nodeBinary = trimEnv("T3CODE_REBOUNCE_NODE_BINARY") || "node";
  await mkdir(dirname(launchdLauncherPath), { recursive: true });
  await mkdir(dirname(launchdPlistPath), { recursive: true });
  await mkdir(launchdLogDir, { recursive: true });

  await writeFile(
    launchdLauncherPath,
    buildLaunchdWrapperScript({
      baseDir,
      homeDir,
      logDir: launchdLogDir,
      nodeBinary,
      pathEnv: defaultPathEnv,
      port: serverPort,
      repoRoot,
      serverHost,
    }),
  );
  await chmod(launchdLauncherPath, 0o755);

  await writeFile(
    launchdPlistPath,
    buildLaunchdPlist({
      environmentVariables: resolveLaunchdEnvironmentVariables(),
      label: serviceName,
      launcherPath: launchdLauncherPath,
      stderrPath: launchdStderrPath,
      stdoutPath: launchdStdoutPath,
      workingDirectory: repoRoot,
    }),
  );

  await logLine(`installed default launchd setup: ${launchdPlistPath}`);
}

async function restartService(): Promise<void> {
  if (supervisorKind === "systemd") {
    await runCommand("sudo", ["systemctl", "restart", serviceName], { stdio: "inherit" });
    return;
  }

  await runCommand("launchctl", ["bootout", launchdDomain, launchdPlistPath], {
    allowFailure: true,
    stdio: "pipe",
  });
  await runCommand("launchctl", ["bootstrap", launchdDomain, launchdPlistPath], {
    stdio: "inherit",
  });
  await runCommand("launchctl", ["enable", `${launchdDomain}/${serviceName}`], {
    allowFailure: true,
    stdio: "pipe",
  });
  await runCommand("launchctl", ["kickstart", "-k", `${launchdDomain}/${serviceName}`], {
    stdio: "inherit",
  });
}

async function waitForServiceRestart(
  beforeRestart: ServiceState,
  timeoutMs: number,
): Promise<ServiceState> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const current = await readServiceState();
    if (
      current.mainPid > 0 &&
      (current.mainPid !== beforeRestart.mainPid || current.stateToken !== beforeRestart.stateToken)
    ) {
      return current;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${serviceName} to restart.`);
    }
    await sleep(pollIntervalMs);
  }
}

async function waitForHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      await runCommand(
        "curl",
        ["-k", "-fsS", "--connect-timeout", "2", "--max-time", "5", "-I", healthUrl],
        { stdio: "ignore" },
      );
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${healthUrl} to become healthy.`);
      }
      await sleep(pollIntervalMs);
    }
  }
}

async function readServiceState(): Promise<ServiceState> {
  if (supervisorKind === "systemd") {
    const result = await runCommand(
      "systemctl",
      ["show", serviceName, "-p", "MainPID", "-p", "ActiveEnterTimestamp"],
      { stdio: "pipe" },
    );
    return parseSystemdServiceState(result.stdout);
  }

  const result = await runCommand("launchctl", ["print", `${launchdDomain}/${serviceName}`], {
    allowFailure: true,
    stdio: "pipe",
  });
  if (result.exitCode !== 0) {
    return { mainPid: 0, stateToken: "" };
  }
  return parseLaunchdServiceState(result.stdout);
}

async function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly allowFailure?: boolean; readonly stdio: "inherit" | "ignore" | "pipe" },
): Promise<CommandResult> {
  await logLine(`run: ${command} ${args.join(" ")}`);
  return await new Promise<CommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: options.stdio === "ignore" ? "ignore" : "pipe",
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (options.stdio === "inherit") {
        process.stdout.write(chunk);
      }
      void appendLogChunk(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (options.stdio === "inherit") {
        process.stderr.write(chunk);
      }
      void appendLogChunk(chunk);
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });

    child.on("close", (code) => {
      const exitCode = code ?? -1;
      if (exitCode === 0) {
        void logLine(`ok: ${command} ${args.join(" ")}`);
        resolvePromise({ exitCode, stderr, stdout });
        return;
      }

      if (options.allowFailure) {
        void logLine(`allow-failure: ${command} ${args.join(" ")} exited with code ${exitCode}`);
        resolvePromise({ exitCode, stderr, stdout });
        return;
      }

      const error = `${command} ${args.join(" ")} exited with code ${exitCode}${
        stderr.trim().length > 0 ? `\n${stderr.trim()}` : ""
      }`;
      void logLine(`error: ${error}`);
      rejectPromise(new Error(error));
    });
  });
}

function resolveDefaultServiceName(kind: SupervisorKind): string {
  if (kind === "systemd") {
    return "t3code.service";
  }

  return `dev.${sanitizeLaunchdLabelComponent(userInfo().username)}.t3code`;
}

function resolveLaunchdDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("launchd rebounce requires a numeric uid on macOS.");
  }
  return `gui/${uid}`;
}

function resolveLaunchdEnvironmentVariables(): Readonly<Record<string, string>> {
  const environmentVariables: Record<string, string> = {
    HOME: homeDir,
    PATH: defaultPathEnv,
  };

  const tlsDomain = trimEnv("T3CODE_REBOUNCE_TLS_DOMAIN");
  const tailscaleBinary = trimEnv("T3CODE_REBOUNCE_TAILSCALE_BINARY");
  const tlsCertDir = trimEnv("T3CODE_REBOUNCE_TLS_CERT_DIR");
  const tlsCertPath = trimEnv("T3CODE_REBOUNCE_TLS_CERT_PATH");
  const tlsKeyPath = trimEnv("T3CODE_REBOUNCE_TLS_KEY_PATH");

  if (tlsDomain) {
    environmentVariables.T3CODE_REBOUNCE_TLS_DOMAIN = tlsDomain;
  }
  if (tailscaleBinary) {
    environmentVariables.T3CODE_REBOUNCE_TAILSCALE_BINARY = tailscaleBinary;
  }
  if (tlsCertDir) {
    environmentVariables.T3CODE_REBOUNCE_TLS_CERT_DIR = tlsCertDir;
  }
  if (tlsCertPath) {
    environmentVariables.T3CODE_REBOUNCE_TLS_CERT_PATH = tlsCertPath;
  }
  if (tlsKeyPath) {
    environmentVariables.T3CODE_REBOUNCE_TLS_KEY_PATH = tlsKeyPath;
  }

  return environmentVariables;
}

function sanitizeLaunchdLabelComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "user";
}

function escapeShellDoubleQuoted(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function trimEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function logStep(message: string): void {
  console.log(`==> ${message}`);
  void logLine(`step: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function logLine(message: string): Promise<void> {
  await appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`);
}

async function appendLogChunk(chunk: string): Promise<void> {
  await appendFile(logPath, chunk);
}

const run = isWorker || supervisorKind === "launchd" ? main : launchWorker;

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  void run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`rebounce failed: ${message}`);
    void logLine(`rebounce failed: ${message}`);
    process.exitCode = 1;
  });
}
