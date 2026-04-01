import type { ProjectBrowseDirectoriesResult } from "@t3tools/contracts";
import {
  ChevronRightIcon,
  FolderIcon,
  HardDriveIcon,
  HomeIcon,
  Loader2Icon,
  MoveUpIcon,
  RefreshCcwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readNativeApi } from "~/nativeApi";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

interface AddProjectDialogProps {
  readonly open: boolean;
  readonly initialPath?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmitPath: (path: string) => Promise<void>;
}

export function AddProjectDialog({
  open,
  initialPath,
  onOpenChange,
  onSubmitPath,
}: AddProjectDialogProps) {
  const pathInputRef = useRef<HTMLInputElement>(null);
  const [directoryListing, setDirectoryListing] = useState<ProjectBrowseDirectoriesResult | null>(
    null,
  );
  const [manualPath, setManualPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadDirectory = useCallback(async (path?: string) => {
    const api = readNativeApi();
    if (!api) {
      setError("Native API not available.");
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const nextListing = await api.projects.browseDirectories(
        path && path.trim().length > 0 ? { path } : {},
      );
      setDirectoryListing(nextListing);
      setManualPath(nextListing.currentPath);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to browse directories.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setDirectoryListing(null);
      setManualPath("");
      setError(null);
      setIsLoading(false);
      setIsSubmitting(false);
      return;
    }

    void loadDirectory(initialPath);
    const frame = window.requestAnimationFrame(() => {
      pathInputRef.current?.focus();
      pathInputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [initialPath, loadDirectory, open]);

  const currentPath = directoryListing?.currentPath ?? manualPath.trim();
  const canSubmit = currentPath.length > 0 && !isLoading && !isSubmitting;

  const rootIconByLabel = useMemo(
    () => ({
      Current: FolderIcon,
      Home: HomeIcon,
      Root: HardDriveIcon,
    }),
    [],
  );

  const handleSubmit = useCallback(async () => {
    const nextPath = currentPath.trim();
    if (!nextPath) {
      setError("Choose a folder to add.");
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      await onSubmitPath(nextPath);
      onOpenChange(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to add project.");
    } finally {
      setIsSubmitting(false);
    }
  }, [currentPath, onOpenChange, onSubmitPath]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSubmitting) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Project</DialogTitle>
          <DialogDescription>
            Browse folders on the host and add the current directory as a project. This works in the
            browser, including on mobile.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid gap-2">
            <span className="text-xs font-medium text-foreground">Jump to</span>
            <div className="flex flex-wrap gap-2">
              {directoryListing?.roots.map((root) => {
                const RootIcon =
                  rootIconByLabel[root.label as keyof typeof rootIconByLabel] ?? FolderIcon;
                return (
                  <Button
                    key={root.path}
                    size="xs"
                    variant="outline"
                    className="max-w-full"
                    onClick={() => void loadDirectory(root.path)}
                    disabled={isLoading || isSubmitting}
                  >
                    <RootIcon className="size-3.5" />
                    <span className="truncate">{root.label}</span>
                  </Button>
                );
              })}
              <Button
                size="xs"
                variant="outline"
                onClick={() => void loadDirectory(directoryListing?.currentPath ?? initialPath)}
                disabled={isLoading || isSubmitting}
              >
                <RefreshCcwIcon className={`size-3.5 ${isLoading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </div>

          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Current folder</span>
            <Input
              ref={pathInputRef}
              value={manualPath}
              onChange={(event) => {
                setManualPath(event.target.value);
                if (error) {
                  setError(null);
                }
              }}
              placeholder="/path/to/project"
              className="font-mono text-sm"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void loadDirectory(manualPath);
                }
              }}
            />
          </label>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="shrink-0"
              disabled={isLoading || isSubmitting || manualPath.trim().length === 0}
              onClick={() => void loadDirectory(manualPath)}
            >
              Open path
            </Button>
            <div className="min-w-0 text-xs text-muted-foreground">
              {directoryListing ? (
                <span className="block truncate font-mono">{directoryListing.currentPath}</span>
              ) : (
                <span>{isLoading ? "Loading directories..." : "No folder loaded yet."}</span>
              )}
            </div>
          </div>

          <div className="rounded-xl border bg-muted/24">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                Folders
              </span>
              {directoryListing?.parentPath ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => void loadDirectory(directoryListing.parentPath)}
                  disabled={isLoading || isSubmitting}
                >
                  <MoveUpIcon className="size-3.5" />
                  Up
                </Button>
              ) : null}
            </div>
            <div className="max-h-[50svh] overflow-y-auto p-2">
              {isLoading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2Icon className="size-4 animate-spin" />
                  Loading folders...
                </div>
              ) : directoryListing && directoryListing.entries.length > 0 ? (
                <div className="space-y-1">
                  {directoryListing.parentPath ? (
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm transition-colors hover:bg-accent"
                      onClick={() => void loadDirectory(directoryListing.parentPath)}
                    >
                      <MoveUpIcon className="size-4 text-muted-foreground" />
                      <span className="font-medium text-foreground">..</span>
                    </button>
                  ) : null}
                  {directoryListing.entries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm transition-colors hover:bg-accent"
                      onClick={() => void loadDirectory(entry.path)}
                    >
                      <FolderIcon className="size-4 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                        {entry.name}
                      </span>
                      <ChevronRightIcon className="size-4 text-muted-foreground/70" />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  No subfolders found here.
                </div>
              )}
            </div>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {isSubmitting ? "Adding..." : "Add this folder"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
