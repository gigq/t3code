import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { NetService } from "@t3tools/shared/Net";
import { cli } from "./cli";
import { version } from "../package.json" with { type: "json" };

const program = Command.run(cli, { version }).pipe(
  Effect.scoped,
  Effect.provide([NodeServices.layer, NetService.layer]),
);

NodeRuntime.runMain(program as Effect.Effect<void, never>);
