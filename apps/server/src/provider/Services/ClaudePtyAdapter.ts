import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface ClaudePtyAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "claudePty";
}

export class ClaudePtyAdapter extends ServiceMap.Service<ClaudePtyAdapter, ClaudePtyAdapterShape>()(
  "t3/provider/Services/ClaudePtyAdapter",
) {}
