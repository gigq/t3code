import type { OpenCodeSettings, ServerProvider } from "@t3tools/contracts";
import { Cause, Effect, Equal, Layer, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
} from "../providerSnapshot.ts";
import { OpenCodeProvider } from "../Services/OpenCodeProvider.ts";
import {
  DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  createOpenCodeSdkClient,
  flattenOpenCodeModels,
  loadOpenCodeInventory,
  runOpenCodeCommand,
  startOpenCodeServerProcess,
} from "../opencodeRuntime.ts";

const PROVIDER = "opencode" as const;

function checkOpenCodeProviderStatus(input: {
  readonly settings: OpenCodeSettings;
  readonly cwd: string;
}): Effect.Effect<ServerProvider> {
  const checkedAt = new Date().toISOString();
  const customModels = input.settings.customModels;

  const fallback = (cause: unknown, version: string | null = null) => {
    const installed = !isCommandMissingCause(cause);
    return buildServerProvider({
      provider: PROVIDER,
      enabled: input.settings.enabled,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        PROVIDER,
        customModels,
        DEFAULT_OPENCODE_MODEL_CAPABILITIES,
      ),
      probe: {
        installed,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          installed && cause instanceof Error
            ? cause.message
            : installed
              ? "Failed to probe OpenCode CLI."
              : "OpenCode CLI not found on PATH.",
      },
    });
  };

  return Effect.gen(function* () {
    const versionExit = yield* Effect.exit(
      Effect.tryPromise(() =>
        runOpenCodeCommand({
          binaryPath: input.settings.binaryPath,
          args: ["--version"],
        }),
      ),
    );
    if (versionExit._tag === "Failure") {
      return fallback(Cause.squash(versionExit.cause));
    }

    const version = parseGenericCliVersion(versionExit.value.stdout) ?? null;
    if (!input.settings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models: providerModelsFromSettings(
          [],
          PROVIDER,
          customModels,
          DEFAULT_OPENCODE_MODEL_CAPABILITIES,
        ),
        probe: {
          installed: true,
          version,
          status: "warning",
          auth: { status: "unknown" },
          message: "OpenCode is disabled in T3 Code settings.",
        },
      });
    }

    const inventoryExit = yield* Effect.exit(
      Effect.acquireUseRelease(
        Effect.tryPromise(() =>
          startOpenCodeServerProcess({ binaryPath: input.settings.binaryPath }),
        ),
        (server) =>
          Effect.tryPromise(async () => {
            const client = createOpenCodeSdkClient({ baseUrl: server.url, directory: input.cwd });
            return await loadOpenCodeInventory(client);
          }),
        (server) => Effect.sync(() => server.close()),
      ),
    );
    if (inventoryExit._tag === "Failure") {
      return fallback(Cause.squash(inventoryExit.cause), version);
    }

    const models = providerModelsFromSettings(
      flattenOpenCodeModels(inventoryExit.value),
      PROVIDER,
      customModels,
      DEFAULT_OPENCODE_MODEL_CAPABILITIES,
    );
    const connectedCount = inventoryExit.value.providerList.connected.length;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: connectedCount > 0 ? "ready" : "warning",
        auth: {
          status: connectedCount > 0 ? "authenticated" : "unknown",
          type: "opencode",
        },
        message:
          connectedCount > 0
            ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through OpenCode.`
            : "OpenCode is available, but it did not report any connected upstream providers.",
      },
    });
  });
}

export function makeOpenCodeProviderLive() {
  return Layer.effect(
    OpenCodeProvider,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;

      const getProviderSettings = serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.opencode),
      );

      return yield* makeManagedServerProvider<OpenCodeSettings>({
        getSettings: getProviderSettings.pipe(Effect.orDie),
        streamSettings: serverSettings.streamChanges.pipe(
          Stream.map((settings) => settings.providers.opencode),
        ),
        haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
        checkProvider: getProviderSettings.pipe(
          Effect.flatMap((settings) =>
            checkOpenCodeProviderStatus({
              settings,
              cwd: serverConfig.cwd,
            }),
          ),
        ),
      });
    }),
  );
}

export const OpenCodeProviderLive = makeOpenCodeProviderLive();
