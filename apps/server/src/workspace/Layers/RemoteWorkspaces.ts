import { Effect, Layer, Option } from "effect";

import { runProcess } from "../../processRunner.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import {
  RemoteWorkspaces,
  RemoteWorkspaceError,
  type RemoteWorkspacesShape,
} from "../Services/RemoteWorkspaces.ts";
import { buildRemoteShellCommand, buildSshArgs } from "../RemoteShell.ts";

function toRemoteWorkspaceError(
  operation: string,
  workspaceRoot: string | undefined,
  cause: unknown,
): RemoteWorkspaceError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new RemoteWorkspaceError({
    operation,
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    detail,
    cause,
  });
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

export const makeRemoteWorkspaces = Effect.gen(function* () {
  const repository = yield* ProjectionProjectRepository;

  const resolveWorkspaceRoot: RemoteWorkspacesShape["resolveWorkspaceRoot"] = Effect.fn(
    "RemoteWorkspaces.resolveWorkspaceRoot",
  )(function* (workspaceRoot) {
    const byWorkspaceRoot = yield* repository
      .getByWorkspaceRoot({ workspaceRoot })
      .pipe(
        Effect.mapError((cause) =>
          toRemoteWorkspaceError("RemoteWorkspaces.getByWorkspaceRoot", workspaceRoot, cause),
        ),
      );
    if (Option.isSome(byWorkspaceRoot)) {
      const project = byWorkspaceRoot.value;
      if (project.deletedAt === null && project.location.kind === "ssh") {
        return Option.some({
          projectId: project.projectId,
          workspaceRoot: project.workspaceRoot,
          location: project.location,
          remoteCwd: project.location.remotePath,
        });
      }
      return Option.none();
    }

    const normalizedWorkspaceRoot = trimTrailingSlash(workspaceRoot);
    const projects = yield* repository
      .listAll()
      .pipe(
        Effect.mapError((cause) =>
          toRemoteWorkspaceError("RemoteWorkspaces.listAll", workspaceRoot, cause),
        ),
      );
    const project = projects.find(
      (candidate) =>
        candidate.deletedAt === null &&
        candidate.location.kind === "ssh" &&
        trimTrailingSlash(candidate.location.remotePath) === normalizedWorkspaceRoot,
    );
    if (!project || project.location.kind !== "ssh") {
      return Option.none();
    }
    return Option.some({
      projectId: project.projectId,
      workspaceRoot: project.workspaceRoot,
      location: project.location,
      remoteCwd: project.location.remotePath,
    });
  });

  const runShell: RemoteWorkspacesShape["runShell"] = Effect.fn("RemoteWorkspaces.runShell")(
    function* (input) {
      const resolved = yield* resolveWorkspaceRoot(input.cwd);
      if (Option.isNone(resolved)) {
        return yield* new RemoteWorkspaceError({
          operation: "RemoteWorkspaces.runShell",
          workspaceRoot: input.cwd,
          detail: "Workspace root is not an SSH-backed project.",
        });
      }

      const remoteCommand = buildRemoteShellCommand({
        cwd: resolved.value.remoteCwd,
        script: input.script,
      });
      const sshArgs = buildSshArgs(resolved.value.location, remoteCommand);

      return yield* Effect.tryPromise({
        try: () =>
          runProcess("ssh", sshArgs, {
            ...input.options,
            env: process.env,
          }),
        catch: (cause) => toRemoteWorkspaceError("RemoteWorkspaces.runShell", input.cwd, cause),
      });
    },
  );

  return {
    resolveWorkspaceRoot,
    runShell,
  } satisfies RemoteWorkspacesShape;
});

export const RemoteWorkspacesLive = Layer.effect(RemoteWorkspaces, makeRemoteWorkspaces);
