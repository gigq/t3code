import { ServiceMap } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface ClaudePtyProviderShape extends ServerProviderShape {}

export class ClaudePtyProvider extends ServiceMap.Service<
  ClaudePtyProvider,
  ClaudePtyProviderShape
>()("t3/provider/Services/ClaudePtyProvider") {}
