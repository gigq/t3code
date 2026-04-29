import { ProjectId, ProjectLocation } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect as EffectType } from "effect";
import type { ProcessRunOptions, ProcessRunResult } from "../../processRunner.ts";

export interface RemoteWorkspaceProjectBinding {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly location: ProjectLocation;
}

export interface ResolvedRemoteWorkspace extends RemoteWorkspaceProjectBinding {
  readonly location: Extract<ProjectLocation, { kind: "ssh" }>;
  readonly remoteCwd: string;
}

export function providerWorkspaceRootForProject(input: {
  readonly workspaceRoot: string;
  readonly location: ProjectLocation;
}): string {
  return input.location.kind === "ssh" ? input.location.remotePath : input.workspaceRoot;
}

export class RemoteWorkspaceError extends Schema.TaggedErrorClass<RemoteWorkspaceError>()(
  "RemoteWorkspaceError",
  {
    operation: Schema.String,
    workspaceRoot: Schema.optional(Schema.String),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface RemoteWorkspacesShape {
  readonly resolveWorkspaceRoot: (
    workspaceRoot: string,
  ) => EffectType.Effect<Option.Option<ResolvedRemoteWorkspace>, RemoteWorkspaceError>;
  readonly runShell: (input: {
    readonly cwd: string;
    readonly script: string;
    readonly options?: Omit<ProcessRunOptions, "cwd" | "env">;
  }) => EffectType.Effect<ProcessRunResult, RemoteWorkspaceError>;
}

export class RemoteWorkspaces extends ServiceMap.Service<RemoteWorkspaces, RemoteWorkspacesShape>()(
  "t3/workspace/Services/RemoteWorkspaces",
) {}
