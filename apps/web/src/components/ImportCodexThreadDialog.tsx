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
  readonly provider: "codex" | "claudeAgent";
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: { providerThreadId: string; title?: string }) => Promise<void>;
}

const CLAUDE_SESSION_ID_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

function extractClaudeSessionId(raw: string): string | null {
  const match = CLAUDE_SESSION_ID_REGEX.exec(raw.trim());
  return match?.[0] ?? null;
}

export function ImportCodexThreadDialog({
  open,
  projectName,
  provider,
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
    const normalizedProviderThreadId =
      provider === "codex"
        ? extractCodexThreadId(providerThreadId)
        : extractClaudeSessionId(providerThreadId);
    if (!normalizedProviderThreadId) {
      setError(
        provider === "codex"
          ? "Enter a valid Codex session or thread ID."
          : "Enter a valid Claude session ID.",
      );
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
        submitError instanceof Error
          ? submitError.message
          : provider === "codex"
            ? "Failed to import Codex thread."
            : "Failed to import Claude thread.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const providerLabel = provider === "codex" ? "Codex" : "Claude";
  const providerIdLabel = provider === "codex" ? "Codex session or thread ID" : "Claude session ID";
  const titlePlaceholder =
    provider === "codex" ? "Imported Codex thread" : "Imported Claude thread";
  const idPlaceholder =
    provider === "codex"
      ? "019d1c3b-3d2a-7fb0-bca8-1290528ded4a"
      : "550e8400-e29b-41d4-a716-446655440000";

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
          <DialogTitle>Import {providerLabel} Thread</DialogTitle>
          <DialogDescription>
            Paste a {providerLabel} session ID to create a new thread in {projectName}. T3 will keep
            the resume binding and reconnect to that provider session on the next turn.
            {provider === "claudeAgent"
              ? " Claude may not expose historical transcript content during import."
              : null}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">{providerIdLabel}</span>
            <Input
              ref={providerThreadIdInputRef}
              placeholder={idPlaceholder}
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
              placeholder={titlePlaceholder}
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
