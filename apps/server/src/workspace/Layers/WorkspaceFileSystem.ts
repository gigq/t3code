import { Effect, FileSystem, Layer, Option, Path } from "effect";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import {
  RemoteWorkspaces,
  type RemoteWorkspaceError,
  type ResolvedRemoteWorkspace,
} from "../Services/RemoteWorkspaces.ts";
import { shellQuote } from "../RemoteShell.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;
  const remoteWorkspacesOption = yield* Effect.serviceOption(RemoteWorkspaces);

  const resolveRemoteWorkspace = (
    cwd: string,
  ): Effect.Effect<Option.Option<ResolvedRemoteWorkspace>, RemoteWorkspaceError> =>
    Option.isSome(remoteWorkspacesOption)
      ? remoteWorkspacesOption.value.resolveWorkspaceRoot(cwd)
      : Effect.succeed(Option.none());

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const remoteWorkspace = yield* resolveRemoteWorkspace(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.ensureRemoteWorkspace",
            detail: cause.message,
            cause,
          }),
      ),
    );
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    if (Option.isSome(remoteWorkspace) && Option.isSome(remoteWorkspacesOption)) {
      const relativeDir = path.dirname(target.relativePath);
      const mkdirScript = relativeDir === "." ? "" : `mkdir -p -- ${shellQuote(relativeDir)} && `;
      yield* remoteWorkspacesOption.value
        .runShell({
          cwd: input.cwd,
          script: `${mkdirScript}cat > ${shellQuote(target.relativePath)}`,
          options: {
            stdin: input.contents,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceFileSystemError({
                cwd: input.cwd,
                relativePath: input.relativePath,
                operation: "workspaceFileSystem.remoteWriteFile",
                detail: cause.message,
                cause,
              }),
          ),
        );
      yield* workspaceEntries.invalidate(input.cwd);
      return { relativePath: target.relativePath };
    }

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });
  return { writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
