import { type ProviderRuntimeEvent, type ThreadId } from "@t3tools/contracts";
import { BugIcon, XIcon } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "./ui/button";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;
const MAX_BUFFERED_EVENTS = 500;

interface ThreadDebugDrawerProps {
  threadId: ThreadId;
  visible: boolean;
  height: number;
  onHeightChange: (height: number) => void;
  onClose: () => void;
}

type RuntimeEventEntry = {
  id: string;
  event: ProviderRuntimeEvent;
};

function maxDrawerHeight(): number {
  if (typeof window === "undefined") {
    return MIN_DRAWER_HEIGHT;
  }
  return Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO));
}

function clampDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : MIN_DRAWER_HEIGHT;
  return Math.min(Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT), maxDrawerHeight());
}

function mergeRuntimeEvents(
  current: ReadonlyArray<RuntimeEventEntry>,
  nextEvent: ProviderRuntimeEvent,
): ReadonlyArray<RuntimeEventEntry> {
  const existingIndex = current.findIndex((entry) => entry.id === nextEvent.eventId);
  const nextEntry: RuntimeEventEntry = {
    id: nextEvent.eventId,
    event: nextEvent,
  };

  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = nextEntry;
    return next;
  }

  return current.length >= MAX_BUFFERED_EVENTS
    ? [...current.slice(1), nextEntry]
    : [...current, nextEntry];
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function DebugEventCard({ event }: { event: ProviderRuntimeEvent }) {
  const rawBlock = event.raw
    ? [
        `source: ${event.raw.source}`,
        ...(event.raw.method ? [`method: ${event.raw.method}`] : []),
        ...(event.raw.messageType ? [`messageType: ${event.raw.messageType}`] : []),
      ].join("\n")
    : null;

  return (
    <article className="rounded-lg border border-border/70 bg-background/70">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">{event.type}</span>
        <span>{formatTimestamp(event.createdAt)}</span>
        {event.turnId ? <span>turn {event.turnId}</span> : null}
        {event.itemId ? <span>item {event.itemId}</span> : null}
        {event.requestId ? <span>request {event.requestId}</span> : null}
      </div>
      <div className="space-y-3 px-3 py-3">
        {rawBlock ? (
          <section className="space-y-1">
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Raw
            </p>
            <pre className="overflow-x-auto rounded-md bg-muted/60 p-3 text-xs leading-5 text-foreground">
              {rawBlock}
              {"\n\n"}
              {formatJson(event.raw?.payload)}
            </pre>
          </section>
        ) : null}
        <section className="space-y-1">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Canonical
          </p>
          <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 text-xs leading-5 text-foreground">
            {formatJson(event.payload)}
          </pre>
        </section>
      </div>
    </article>
  );
}

export default function ThreadDebugDrawer({
  threadId,
  visible,
  height,
  onHeightChange,
  onClose,
}: ThreadDebugDrawerProps) {
  const [drawerHeight, setDrawerHeight] = useState(() => clampDrawerHeight(height));
  const [entries, setEntries] = useState<ReadonlyArray<RuntimeEventEntry>>([]);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const drawerHeightRef = useRef(drawerHeight);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);

  const syncHeight = useEffectEvent((nextHeight: number) => {
    const clampedHeight = clampDrawerHeight(nextHeight);
    drawerHeightRef.current = clampedHeight;
    setDrawerHeight(clampedHeight);
    onHeightChange(clampedHeight);
  });

  const handleRuntimeEvent = useEffectEvent((event: ProviderRuntimeEvent) => {
    setEntries((current) => mergeRuntimeEvents(current, event));
  });

  useEffect(() => {
    const clampedHeight = clampDrawerHeight(height);
    drawerHeightRef.current = clampedHeight;
    setDrawerHeight(clampedHeight);
  }, [height]);

  useEffect(() => {
    if (!visible) {
      setIsSubscribed(false);
      return;
    }

    const api = readNativeApi();
    if (!api) {
      setIsSubscribed(false);
      return;
    }

    setEntries([]);
    setIsSubscribed(true);
    const unsubscribe = api.orchestration.onProviderRuntimeEvent(threadId, (event) => {
      handleRuntimeEvent(event);
    });

    return () => {
      unsubscribe();
      setIsSubscribed(false);
    };
  }, [threadId, visible]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }
    const distanceFromBottom =
      scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    if (distanceFromBottom > 48) {
      return;
    }
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }, [entries.length]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const handleWindowResize = () => {
      syncHeight(drawerHeightRef.current);
    };

    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [visible]);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    syncHeight(resizeState.startHeight - (event.clientY - resizeState.startY));
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    resizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const statusLabel = useMemo(() => {
    if (!visible) return "Hidden";
    if (!isSubscribed && entries.length === 0) return "Connecting";
    return `${entries.length} event${entries.length === 1 ? "" : "s"}`;
  }, [entries.length, isSubscribed, visible]);

  if (!visible) {
    return null;
  }

  return (
    <section
      className={cn(
        "relative flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/80 bg-background",
        "supports-[backdrop-filter]:bg-background/95 supports-[backdrop-filter]:backdrop-blur",
      )}
      style={{ height: `${drawerHeight}px` }}
    >
      <div
        className="absolute inset-x-0 top-0 z-10 h-2 cursor-row-resize touch-none"
        onPointerDown={beginResize}
        onPointerMove={updateResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
      <div className="flex min-h-0 flex-1 flex-col pt-2">
        <header className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <BugIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">Provider Debug</p>
              <p className="truncate text-xs text-muted-foreground">{statusLabel}</p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            aria-label="Close provider debug drawer"
          >
            <XIcon className="size-4" />
          </Button>
        </header>
        <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto px-3 py-3 sm:px-5">
          {entries.length === 0 ? (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
              Waiting for provider runtime events for this thread.
            </div>
          ) : (
            <div className="space-y-3">
              {entries.map((entry) => (
                <DebugEventCard key={entry.id} event={entry.event} />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
