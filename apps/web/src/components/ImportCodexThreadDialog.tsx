import { extractCodexThreadId } from "@t3tools/shared/codex";
import { useEffect, useRef, useState } from "react";

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

interface ImportCodexThreadDialogProps {
  readonly open: boolean;
  readonly projectName: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: { providerThreadId: string; title?: string }) => Promise<void>;
}

export function ImportCodexThreadDialog({
  open,
  projectName,
  onOpenChange,
  onSubmit,
}: ImportCodexThreadDialogProps) {
  const providerThreadIdInputRef = useRef<HTMLInputElement>(null);
  const [providerThreadId, setProviderThreadId] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setProviderThreadId("");
      setTitle("");
      setError(null);
      setIsSubmitting(false);
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      providerThreadIdInputRef.current?.focus();
      providerThreadIdInputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  const handleSubmit = async () => {
    const normalizedProviderThreadId = extractCodexThreadId(providerThreadId);
    if (!normalizedProviderThreadId) {
      setError("Enter a valid Codex session or thread ID.");
      return;
    }

    if (normalizedProviderThreadId !== providerThreadId) {
      setProviderThreadId(normalizedProviderThreadId);
    }

    setError(null);
    setIsSubmitting(true);
    try {
      await onSubmit({
        providerThreadId: normalizedProviderThreadId,
        ...(title.trim().length > 0 ? { title: title.trim() } : {}),
      });
      onOpenChange(false);
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "Failed to import Codex thread.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSubmitting) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import Codex Thread</DialogTitle>
          <DialogDescription>
            Paste a Codex session or thread ID to create a new thread in {projectName}. T3 will
            resume that session and copy its user and assistant messages into the new thread.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Codex session or thread ID</span>
            <Input
              ref={providerThreadIdInputRef}
              placeholder="019d1c3b-3d2a-7fb0-bca8-1290528ded4a"
              value={providerThreadId}
              onChange={(event) => {
                setProviderThreadId(event.target.value);
                if (error) {
                  setError(null);
                }
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") {
                  return;
                }
                event.preventDefault();
                if (!isSubmitting) {
                  void handleSubmit();
                }
              }}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Title override (optional)</span>
            <Input
              placeholder="Imported Codex thread"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={isSubmitting}>
            {isSubmitting ? "Importing..." : "Import thread"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
