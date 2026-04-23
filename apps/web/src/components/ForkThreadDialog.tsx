import { type ModelSelection, type ProviderKind, type ServerProvider } from "@t3tools/contracts";
import { type UnifiedSettings } from "@t3tools/contracts/settings";
import { useEffect, useMemo, useRef, useState } from "react";

import { resolveAppModelSelection } from "../modelSelection";
import { resolveSelectableProvider } from "../providerModels";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
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

interface ForkThreadDialogProps {
  readonly open: boolean;
  readonly sourceThreadTitle: string;
  readonly sourceMessageId?: string | null;
  readonly sourceModelSelection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly modelOptionsByProvider: Record<
    ProviderKind,
    ReadonlyArray<{ slug: string; name: string }>
  >;
  readonly settings: UnifiedSettings;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: {
    readonly modelSelection: ModelSelection;
    readonly title?: string;
  }) => Promise<void>;
}

export function ForkThreadDialog({
  open,
  sourceThreadTitle,
  sourceMessageId = null,
  sourceModelSelection,
  providers,
  modelOptionsByProvider,
  settings,
  onOpenChange,
  onSubmit,
}: ForkThreadDialogProps) {
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [modelSelection, setModelSelection] = useState<ModelSelection>(sourceModelSelection);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setModelSelection(sourceModelSelection);
      setError(null);
      setIsSubmitting(false);
      return;
    }

    setTitle("");
    setModelSelection(sourceModelSelection);
    setError(null);

    const frame = window.requestAnimationFrame(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open, sourceModelSelection]);

  const resolvedModelSelection = useMemo<ModelSelection>(() => {
    const provider = resolveSelectableProvider(providers, modelSelection.provider);
    const model = resolveAppModelSelection(provider, settings, providers, modelSelection.model);
    return {
      provider,
      model,
    };
  }, [modelSelection.model, modelSelection.provider, providers, settings]);

  const handleSubmit = async () => {
    setError(null);
    setIsSubmitting(true);
    try {
      await onSubmit({
        modelSelection: resolvedModelSelection,
        ...(title.trim().length > 0 ? { title: title.trim() } : {}),
      });
      onOpenChange(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to fork thread.");
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
          <DialogTitle>Fork Thread</DialogTitle>
          <DialogDescription>
            Create a new thread from{" "}
            <span className="font-medium text-foreground">{sourceThreadTitle}</span>
            {sourceMessageId
              ? ". The fork will include conversation history through the selected user message."
              : "."}{" "}
            The fork keeps the current access mode and starts in Chat mode so you can continue with
            a different provider or model.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Title override (optional)</span>
            <Input
              ref={titleInputRef}
              placeholder={`${sourceThreadTitle} (fork)`}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
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
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Provider and model</span>
            <ProviderModelPicker
              provider={resolvedModelSelection.provider}
              model={resolvedModelSelection.model}
              lockedProvider={null}
              providers={providers}
              modelOptionsByProvider={modelOptionsByProvider}
              triggerVariant="outline"
              triggerClassName="w-full max-w-none justify-between"
              onProviderModelChange={(provider, model) => {
                setModelSelection({
                  provider,
                  model,
                });
                if (error) {
                  setError(null);
                }
              }}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={isSubmitting}>
            {isSubmitting ? "Forking..." : "Fork thread"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
