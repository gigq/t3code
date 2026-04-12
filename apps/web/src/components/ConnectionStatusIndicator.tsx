import { CheckCircle2, CloudOff, LoaderCircle, TriangleAlert } from "lucide-react";
import { useLocation } from "@tanstack/react-router";

import { useServerConfig } from "../rpc/serverState";
import { getWsConnectionUiState, useWsConnectionStatus } from "../rpc/wsConnectionState";
import { useStore } from "../store";
import { Button } from "./ui/button";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "./ui/popover";
import {
  deriveConnectionStatusIndicatorModel,
  type ActiveThreadConnectionState,
} from "./ConnectionStatusIndicator.logic";
import { cn } from "~/lib/utils";
import { parseThreadIdFromNotificationUrlPath } from "../lib/webPush";

const connectionTimeFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  second: "2-digit",
});

function formatMoment(isoDate: string | null): string {
  if (!isoDate) {
    return "n/a";
  }

  return connectionTimeFormatter.format(new Date(isoDate));
}

function describeActiveThreadState(state: ActiveThreadConnectionState): string {
  switch (state) {
    case "loading":
      return "Loading";
    case "error":
      return "Needs recovery";
    case "missing":
      return "Missing";
    case "ready":
      return "Ready";
    default:
      return "n/a";
  }
}

function ConnectionStateIcon({
  icon,
  tone,
}: {
  readonly icon: ReturnType<typeof deriveConnectionStatusIndicatorModel>["icon"];
  readonly tone: ReturnType<typeof deriveConnectionStatusIndicatorModel>["tone"];
}) {
  const className = cn(
    "size-3.5 shrink-0",
    tone === "success" && "text-emerald-500",
    tone === "pending" && "text-sky-500",
    tone === "warning" && "text-amber-500",
    tone === "danger" && "text-red-500",
    tone === "neutral" && "text-muted-foreground",
  );

  if (icon === "check") {
    return <CheckCircle2 className={className} />;
  }
  if (icon === "offline") {
    return <CloudOff className={className} />;
  }
  if (icon === "loader") {
    return <LoaderCircle className={cn(className, "animate-spin")} />;
  }
  return <TriangleAlert className={className} />;
}

function triggerToneClass(tone: ReturnType<typeof deriveConnectionStatusIndicatorModel>["tone"]) {
  switch (tone) {
    case "success":
      return "border-emerald-500/30 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300";
    case "pending":
      return "border-sky-500/30 bg-sky-500/8 text-sky-700 dark:text-sky-300";
    case "warning":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "danger":
      return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
    default:
      return "border-border bg-card text-foreground";
  }
}

export function ConnectionStatusIndicator() {
  const status = useWsConnectionStatus();
  const serverConfig = useServerConfig();
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const threads = useStore((store) => store.threads);
  const pathname = useLocation({ select: (location) => location.pathname });
  const activeThreadId = parseThreadIdFromNotificationUrlPath(pathname);
  const activeThread = activeThreadId
    ? (threads.find((thread) => thread.id === activeThreadId) ?? null)
    : null;
  const activeThreadState: ActiveThreadConnectionState =
    activeThreadId === null
      ? "none"
      : activeThread === null
        ? bootstrapComplete
          ? "missing"
          : "loading"
        : activeThread.detailState === "error"
          ? "error"
          : activeThread.detailState === "loading" || activeThread.detailState === "summary"
            ? "loading"
            : "ready";

  const model = deriveConnectionStatusIndicatorModel({
    activeThreadState,
    bootstrapComplete,
    serverConfigReady: serverConfig !== null,
    status,
  });
  const uiState = getWsConnectionUiState(status);

  return (
    <div className="shrink-0">
      <Popover>
        <PopoverTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              className={cn(
                "h-8 rounded-full shadow-sm backdrop-blur-sm max-sm:w-8 max-sm:px-0 sm:px-2.5",
                triggerToneClass(model.tone),
              )}
              aria-label={`Connection status: ${model.label}`}
            />
          }
        >
          <ConnectionStateIcon icon={model.icon} tone={model.tone} />
          <span className="sr-only md:not-sr-only">{model.label}</span>
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="end"
          sideOffset={8}
          className="w-[min(21rem,calc(100vw-1.5rem))] p-0"
        >
          <div className="space-y-4 p-4">
            <div className="space-y-1">
              <PopoverTitle className="flex items-center gap-2 text-sm font-semibold">
                <ConnectionStateIcon icon={model.icon} tone={model.tone} />
                <span>{model.label}</span>
              </PopoverTitle>
              <PopoverDescription className="text-sm leading-relaxed text-muted-foreground">
                {model.description}
              </PopoverDescription>
            </div>

            <dl className="grid gap-x-3 gap-y-2 text-xs sm:grid-cols-[auto_1fr]">
              <dt className="font-medium text-muted-foreground">WebSocket</dt>
              <dd>{uiState}</dd>

              <dt className="font-medium text-muted-foreground">Reconnect</dt>
              <dd>
                {status.reconnectPhase}
                {status.reconnectAttemptCount > 0
                  ? ` (${status.reconnectAttemptCount}/${status.reconnectMaxAttempts})`
                  : ""}
              </dd>

              <dt className="font-medium text-muted-foreground">Browser online</dt>
              <dd>{status.online ? "yes" : "no"}</dd>

              <dt className="font-medium text-muted-foreground">Bootstrap</dt>
              <dd>{bootstrapComplete ? "ready" : "pending"}</dd>

              {activeThreadId !== null ? (
                <>
                  <dt className="font-medium text-muted-foreground">Thread</dt>
                  <dd>{describeActiveThreadState(activeThreadState)}</dd>
                </>
              ) : null}

              <dt className="font-medium text-muted-foreground">Connected at</dt>
              <dd>{formatMoment(status.connectedAt)}</dd>

              <dt className="font-medium text-muted-foreground">Disconnected at</dt>
              <dd>{formatMoment(status.disconnectedAt)}</dd>

              <dt className="font-medium text-muted-foreground">Next retry</dt>
              <dd>{formatMoment(status.nextRetryAt)}</dd>

              {status.lastError ? (
                <>
                  <dt className="font-medium text-muted-foreground">Most recent error</dt>
                  <dd className="break-words">{status.lastError}</dd>
                </>
              ) : null}

              {status.closeCode !== null ? (
                <>
                  <dt className="font-medium text-muted-foreground">Close code</dt>
                  <dd>
                    {status.closeCode}
                    {status.closeReason ? ` (${status.closeReason})` : ""}
                  </dd>
                </>
              ) : null}
            </dl>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
