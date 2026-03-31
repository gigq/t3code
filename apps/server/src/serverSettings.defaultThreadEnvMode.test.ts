import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ServerConfig } from "./config";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings";

const makeServerSettingsLayer = () =>
  ServerSettingsLive.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-default-thread-env-test-",
        }),
      ),
    ),
  );

it.layer(NodeServices.layer)("server settings default thread env mode", (it) => {
  it.effect("defaults new thread env mode to worktree when settings are unset", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const settings = yield* serverSettings.getSettings;

      assert.equal(settings.defaultThreadEnvMode, "worktree");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
});
