#!/usr/bin/env node

import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const bunBinary = process.execPath;
const serviceName = process.env.T3CODE_REBOUNCE_SERVICE?.trim() || "t3code.service";
const healthUrl = process.env.T3CODE_REBOUNCE_HEALTH_URL?.trim() || "https://127.0.0.1:3773/";
const healthTimeoutMs = Number(process.env.T3CODE_REBOUNCE_TIMEOUT_MS ?? 60_000);
const logPath =
  process.env.T3CODE_REBOUNCE_LOG_PATH?.trim() ||
  resolve(homedir(), ".t3", "userdata", "logs", "rebounce.log");
const pollIntervalMs = 1_000;
const isWorker = process.env.T3CODE_REBOUNCE_WORKER === "1";

interface CommandResult {
  readonly stdout: string;
}

interface ServiceState {
  readonly activeEnterTimestamp: string;
  readonly mainPid: number;
}

async function main(): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, "");
  await logLine(`rebounce starting in ${repoRoot}`);
  await logLine(`log: ${logPath}`);
  await logLine(`service: ${serviceName}`);
  await logLine(`health: ${healthUrl}`);

  const beforeRestart = await readServiceState();
  await logLine(
    `pre-restart service state: pid=${beforeRestart.mainPid} started=${beforeRestart.activeEnterTimestamp}`,
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
  await runCommand("sudo", ["systemctl", "restart", serviceName], { stdio: "inherit" });

  logStep(`Waiting for ${serviceName} to come back`);
  const restartedState = await waitForServiceRestart(beforeRestart, healthTimeoutMs);

  logStep(`Waiting for ${healthUrl} to return 200`);
  await waitForHealthy(healthTimeoutMs);

  console.log("");
  console.log(`rebounce complete`);
  console.log(`service: ${serviceName}`);
  console.log(`pid: ${restartedState.mainPid}`);
  console.log(`started: ${restartedState.activeEnterTimestamp}`);
  console.log(`log: ${logPath}`);
  await logLine(`rebounce complete`);
  await logLine(
    `post-restart service state: pid=${restartedState.mainPid} started=${restartedState.activeEnterTimestamp}`,
  );
  for (const artifact of artifacts) {
    console.log(`artifact: ${artifact.path} @ ${artifact.mtime.toISOString()}`);
    await logLine(`artifact: ${artifact.path} @ ${artifact.mtime.toISOString()}`);
  }
}

async function launchWorker(): Promise<void> {
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

async function waitForServiceRestart(
  beforeRestart: ServiceState,
  timeoutMs: number,
): Promise<ServiceState> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const current = await readServiceState();
    if (
      current.mainPid > 0 &&
      (current.mainPid !== beforeRestart.mainPid ||
        current.activeEnterTimestamp !== beforeRestart.activeEnterTimestamp)
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
  const result = await runCommand(
    "systemctl",
    ["show", serviceName, "-p", "MainPID", "-p", "ActiveEnterTimestamp"],
    { stdio: "pipe" },
  );

  let mainPid = 0;
  let activeEnterTimestamp = "";

  for (const line of result.stdout.trim().split("\n")) {
    if (line.startsWith("MainPID=")) {
      mainPid = Number(line.slice("MainPID=".length));
      continue;
    }
    if (line.startsWith("ActiveEnterTimestamp=")) {
      activeEnterTimestamp = line.slice("ActiveEnterTimestamp=".length);
    }
  }

  return { mainPid, activeEnterTimestamp };
}

async function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly stdio: "inherit" | "ignore" | "pipe" },
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
      if (code === 0) {
        void logLine(`ok: ${command} ${args.join(" ")}`);
        resolvePromise({ stdout });
        return;
      }

      const error = `${command} ${args.join(" ")} exited with code ${code}${
        stderr.trim().length > 0 ? `\n${stderr.trim()}` : ""
      }`;
      void logLine(`error: ${error}`);
      rejectPromise(new Error(error));
    });
  });
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

async function logLine(message: string): Promise<void> {
  await appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`);
}

async function appendLogChunk(chunk: string): Promise<void> {
  await appendFile(logPath, chunk);
}

const run = isWorker ? main : launchWorker;

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`rebounce failed: ${message}`);
  void logLine(`rebounce failed: ${message}`);
  process.exitCode = 1;
});
