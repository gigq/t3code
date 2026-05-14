import type { ClaudePtySettings, ServerProvider } from "@t3tools/contracts";
import { Effect, Equal, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerSettingsError } from "@t3tools/contracts";
import { ServerSettingsService } from "../../serverSettings";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot";
import { ClaudePtyProvider } from "../Services/ClaudePtyProvider";
import {
  CLAUDE_BUILT_IN_MODELS,
  DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  parseClaudeAuthStatusFromOutput,
} from "./ClaudeProvider";

const PROVIDER = "claudePty" as const;

const runClaudePtyCommand = Effect.fn("runClaudePtyCommand")(function* (
  args: ReadonlyArray<string>,
) {
  const claudeSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.claudePty),
  );
  const command = ChildProcess.make(claudeSettings.binaryPath, [...args], {
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

export const checkClaudePtyProviderStatus = Effect.fn("checkClaudePtyProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const claudeSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.claudePty),
    );
    const checkedAt = new Date().toISOString();
    const models = providerModelsFromSettings(
      CLAUDE_BUILT_IN_MODELS,
      PROVIDER,
      claudeSettings.customModels,
      DEFAULT_CLAUDE_MODEL_CAPABILITIES,
    );

    if (!claudeSettings.enabled) {
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
          message: "Claude PTY is disabled in T3 Code settings.",
        },
      });
    }

    const versionProbe = yield* runClaudePtyCommand(["--version"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: claudeSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Claude CLI (`claude`) is not installed or not on PATH."
            : `Failed to execute Claude PTY health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    if (Option.isNone(versionProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: claudeSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Claude CLI is installed but timed out while running `claude --version`.",
        },
      });
    }

    const version = versionProbe.success.value;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return buildServerProvider({
        provider: PROVIDER,
        enabled: claudeSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "error",
          auth: { status: "unknown" },
          message: detail
            ? `Claude CLI is installed but failed to run. ${detail}`
            : "Claude CLI is installed but failed to run.",
        },
      });
    }

    const authProbe = yield* runClaudePtyCommand(["auth", "status"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: claudeSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "warning",
          auth: { status: "unknown" },
          message:
            error instanceof Error
              ? `Could not verify Claude authentication status: ${error.message}.`
              : "Could not verify Claude authentication status.",
        },
      });
    }

    if (Option.isNone(authProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: claudeSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "warning",
          auth: { status: "unknown" },
          message:
            "Could not verify Claude authentication status. Timed out while running command.",
        },
      });
    }

    const parsed = parseClaudeAuthStatusFromOutput(authProbe.success.value);
    return buildServerProvider({
      provider: PROVIDER,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: parsed.status,
        auth: parsed.auth,
        ...(parsed.message ? { message: parsed.message } : {}),
      },
    });
  },
);

export const ClaudePtyProviderLive = Layer.effect(
  ClaudePtyProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const checkProvider = checkClaudePtyProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<ClaudePtySettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.claudePty),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.claudePty),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
