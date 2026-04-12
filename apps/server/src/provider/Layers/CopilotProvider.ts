import type { CopilotSettings, ModelCapabilities } from "@t3tools/contracts";
import { Data, Effect, Equal, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerSettingsService } from "../../serverSettings.ts";
import { createAcpClientConnection } from "../acp/AcpClient.ts";
import { startAcpProcess } from "../acp/AcpProcess.ts";
import { closeAcpSessionRuntime } from "../acp/AcpSessionRuntime.ts";
import { buildCopilotBuiltInModels } from "../copilotCliModels.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  DEFAULT_TIMEOUT_MS,
  buildServerProvider,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import { CopilotProvider } from "../Services/CopilotProvider.ts";

const PROVIDER = "copilot" as const;

const EMPTY_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

class CopilotAcpProbeError extends Data.TaggedError("CopilotAcpProbeError")<{
  readonly cause: unknown;
  readonly detail: string;
}> {}

function hasAcpSupport(helpText: string): boolean {
  return helpText.includes("--acp");
}

function isCopilotAuthFailure(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /authentication required|login required|not authenticated|unauthenticated/i.test(message);
}

const probeCopilotAcpAuth = Effect.fn("probeCopilotAcpAuth")(function* (binaryPath: string) {
  return yield* Effect.acquireUseRelease(
    startAcpProcess({
      binaryPath,
      args: ["--acp", "--stdio", "--no-color"],
      cwd: process.cwd(),
      env: process.env,
    }),
    (processHandle) =>
      Effect.gen(function* () {
        const initialized = yield* createAcpClientConnection({
          client: {
            async sessionUpdate() {},
            async requestPermission(params) {
              const option =
                params.options.find((candidate) => candidate.kind === "allow_once") ??
                params.options.find((candidate) => candidate.kind === "allow_always");
              return option
                ? { outcome: { outcome: "selected", optionId: option.optionId } }
                : { outcome: { outcome: "cancelled" } };
            },
            async readTextFile() {
              return { content: "" };
            },
            async writeTextFile() {
              return {};
            },
            async createTerminal() {
              return { terminalId: "probe-terminal" };
            },
            async terminalOutput() {
              return { output: "", truncated: false };
            },
            async waitForTerminalExit() {
              return { exitCode: 0, signal: null };
            },
            async killTerminal() {
              return {};
            },
            async releaseTerminal() {
              return {};
            },
          },
          stream: processHandle.stream,
        });

        const authResult = yield* Effect.tryPromise({
          try: () =>
            initialized.connection.newSession({
              cwd: process.cwd(),
              mcpServers: [],
            }),
          catch: (cause) =>
            new CopilotAcpProbeError({
              cause,
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        }).pipe(
          Effect.catchIf(isCopilotAuthFailure, () => Effect.succeed("unauthenticated" as const)),
        );

        return authResult === "unauthenticated" ? authResult : ("authenticated" as const);
      }),
    (processHandle) => closeAcpSessionRuntime({ child: processHandle.child }).pipe(Effect.ignore),
  );
});

const runCopilotCommand = Effect.fn("runCopilotCommand")(function* (args: ReadonlyArray<string>) {
  const copilotSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.copilot),
  );
  const command = ChildProcess.make(copilotSettings.binaryPath, [...args], {
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(copilotSettings.binaryPath, command);
});

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  resolveAuthStatus?: (
    binaryPath: string,
  ) => Effect.Effect<"authenticated" | "unauthenticated", CopilotAcpProbeError>,
) {
  const copilotSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.copilot),
  );
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    buildCopilotBuiltInModels(copilotSettings.binaryPath, EMPTY_MODEL_CAPABILITIES),
    PROVIDER,
    copilotSettings.customModels,
    EMPTY_MODEL_CAPABILITIES,
  );

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Copilot is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runCopilotCommand(["version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: copilotSettings.enabled,
      checkedAt,
      models,
      probe: isCommandMissingCause(error)
        ? {
            installed: false,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message: "Copilot CLI not found on PATH.",
          }
        : {
            installed: true,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message: error instanceof Error ? error.message : "Failed to probe Copilot CLI.",
          },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: copilotSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Timed out while running `copilot version`.",
      },
    });
  }

  const versionResult = versionProbe.success.value;
  const helpProbe = yield* runCopilotCommand(["--help"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );
  const parsedVersion = parseGenericCliVersion(versionResult.stdout || versionResult.stderr);

  if (Result.isFailure(helpProbe)) {
    const error = helpProbe.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: copilotSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message:
          error instanceof Error
            ? `Could not verify ACP support: ${error.message}.`
            : "Could not verify ACP support.",
      },
    });
  }

  if (Option.isNone(helpProbe.success)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: copilotSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify ACP support. Timed out while running `copilot --help`.",
      },
    });
  }

  const helpResult = helpProbe.success.value;
  if (!hasAcpSupport(`${helpResult.stdout}\n${helpResult.stderr}`)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: copilotSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Installed, but this Copilot CLI version does not advertise ACP support.",
      },
    });
  }

  const authProbe = yield* (
    resolveAuthStatus
      ? resolveAuthStatus(copilotSettings.binaryPath)
      : probeCopilotAcpAuth(copilotSettings.binaryPath)
  ).pipe(
    Effect.mapError(
      (cause) =>
        new CopilotAcpProbeError({
          cause,
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    ),
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isSuccess(authProbe) && Option.isSome(authProbe.success)) {
    const authStatus = authProbe.success.value;
    if (authStatus === "unauthenticated") {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: copilotSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "error",
          auth: { status: "unauthenticated" },
          message: "Copilot CLI authentication required. Run `copilot login`.",
        },
      });
    }
  }

  const detail = detailFromResult(versionResult);
  return buildServerProvider({
    provider: PROVIDER,
    enabled: copilotSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: { status: "unknown" },
      ...(detail ? { message: detail } : {}),
    },
  });
});

export const CopilotProviderLive = Layer.effect(
  CopilotProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkProvider = checkCopilotProviderStatus((binaryPath) =>
      probeCopilotAcpAuth(binaryPath).pipe(
        Effect.mapError(
          (cause) =>
            new CopilotAcpProbeError({
              cause,
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      ),
    ).pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<CopilotSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.copilot),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.copilot),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
