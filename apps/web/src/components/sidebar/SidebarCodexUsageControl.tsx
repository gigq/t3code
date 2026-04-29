import { useQuery } from "@tanstack/react-query";
import type {
  ServerCodexUsage,
  ServerCodexUsageWindow,
  ServerProviderUsage,
} from "@t3tools/contracts";
import { ActivityIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { serverCodexUsageQueryOptions } from "~/lib/serverReactQuery";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }
  return `${Math.round(value)}%`;
}

function formatCredits(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  return formatContextWindowTokens(value);
}

function triggerToneClass(primaryLeftPercent: number | null, available: boolean | null): string {
  if (available === false) {
    return "border-amber-500/30 text-amber-200 hover:bg-amber-500/10";
  }
  if (primaryLeftPercent !== null && primaryLeftPercent <= 10) {
    return "border-red-500/30 text-red-200 hover:bg-red-500/10";
  }
  if (primaryLeftPercent !== null && primaryLeftPercent <= 25) {
    return "border-amber-500/30 text-amber-200 hover:bg-amber-500/10";
  }
  return "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground";
}

function UsageWindowCard(props: {
  label: string;
  window: ServerCodexUsageWindow | null;
  accentClassName?: string;
}) {
  const { label, window, accentClassName = "bg-foreground/80" } = props;
  const leftPercent = window?.leftPercent ?? null;
  const progress = leftPercent === null ? 0 : Math.max(0, Math.min(100, leftPercent));

  return (
    <div className="space-y-1.5 rounded-xl border border-border/70 bg-muted/20 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {label}
        </div>
        <div className="text-sm font-semibold text-foreground">
          {formatPercent(leftPercent)} left
        </div>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted/60">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${accentClassName}`}
          style={{ width: `${progress}%` }}
        />
      </div>
      {window?.resetDescription ? (
        <div className="text-xs text-muted-foreground">Resets {window.resetDescription}</div>
      ) : null}
    </div>
  );
}

function providerLabel(provider: string): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    default:
      return provider;
  }
}

function providerAccentClass(provider: string, secondary = false): string {
  if (provider === "claude") {
    return secondary ? "bg-orange-400/55" : "bg-orange-400/80";
  }
  return secondary ? "bg-foreground/55" : "bg-foreground/80";
}

function ProviderUsageSection(props: { title: string; usage: ServerProviderUsage }) {
  const { title, usage } = props;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {usage.accountEmail ?? usage.source ?? usage.provider}
        </div>
      </div>
      <UsageWindowCard
        label="Session"
        window={usage.primary}
        accentClassName={providerAccentClass(usage.provider)}
      />
      {usage.secondary ? (
        <UsageWindowCard
          label="Weekly"
          window={usage.secondary}
          accentClassName={providerAccentClass(usage.provider, true)}
        />
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Credits
          </div>
          <div className="mt-1 text-sm font-semibold text-foreground">
            {formatCredits(usage.creditsRemaining)}
          </div>
        </div>
        <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Source
          </div>
          <div className="mt-1 truncate text-sm font-semibold text-foreground">
            {usage.source ?? usage.provider}
          </div>
        </div>
      </div>
    </div>
  );
}

function CodexUsageContent(props: {
  isLoading: boolean;
  usage: ServerCodexUsage | undefined;
  currentThreadTitle: string | null;
  currentContextWindow: ContextWindowSnapshot | null;
  isRefetching: boolean;
  onRefresh: () => void;
}) {
  const { isLoading, usage, currentThreadTitle, currentContextWindow, isRefetching, onRefresh } =
    props;

  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">Codex usage</div>
            <div className="text-xs text-muted-foreground">Loading current account limits…</div>
          </div>
        </div>
        <div className="space-y-2">
          <div className="h-16 animate-pulse rounded-xl bg-muted/40" />
          <div className="h-16 animate-pulse rounded-xl bg-muted/30" />
        </div>
      </div>
    );
  }

  const additionalProviders = usage?.additionalProviders ?? [];
  const availableAdditionalProviders = additionalProviders.filter((provider) => provider.available);
  const hasAnyAvailable = Boolean(usage?.available || availableAdditionalProviders.length > 0);

  if (!usage || !hasAnyAvailable) {
    return (
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">T3 Code usage</div>
            <div className="text-xs text-muted-foreground">
              {usage?.error ?? "Usage is unavailable on this server."}
            </div>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            aria-label="Refresh Codex usage"
            onClick={onRefresh}
          >
            <RefreshCwIcon className={`size-3.5 ${isRefetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/8 p-3 text-xs text-amber-100">
          <div className="flex items-start gap-2">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            <div>
              <div>Make sure `codexbar` is installed and authenticated on the host.</div>
              {currentContextWindow ? (
                <div className="mt-2 text-amber-50/90">
                  Current thread context: {formatPercent(currentContextWindow.remainingPercentage)}{" "}
                  left
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">T3 Code usage</div>
          <div className="truncate text-xs text-muted-foreground">
            {usage.available
              ? (usage.accountEmail ?? "Codex account")
              : `${availableAdditionalProviders.length} provider available`}
          </div>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          aria-label="Refresh Codex usage"
          onClick={onRefresh}
        >
          <RefreshCwIcon className={`size-3.5 ${isRefetching ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {usage.available ? (
        <ProviderUsageSection title="Codex" usage={usage} />
      ) : (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/8 p-3 text-xs text-amber-100">
          Codex usage unavailable: {usage.error ?? "Unknown error"}
        </div>
      )}

      {availableAdditionalProviders.map((provider) => (
        <ProviderUsageSection
          key={provider.provider}
          title={providerLabel(provider.provider)}
          usage={provider}
        />
      ))}

      {usage.available && (usage.sparkPrimary || usage.sparkSecondary) ? (
        <div className="space-y-2">
          <div className="px-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            GPT-5.3-Codex-Spark
          </div>
          {usage.sparkPrimary ? (
            <UsageWindowCard
              label="5h"
              window={usage.sparkPrimary}
              accentClassName="bg-cyan-400/80"
            />
          ) : null}
          {usage.sparkSecondary ? (
            <UsageWindowCard
              label="Weekly"
              window={usage.sparkSecondary}
              accentClassName="bg-cyan-400/55"
            />
          ) : null}
        </div>
      ) : null}

      {currentContextWindow ? (
        <div className="space-y-1.5 rounded-xl border border-border/70 bg-muted/20 p-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Thread context
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
              {currentThreadTitle ?? "Current thread"}
            </div>
            <div className="shrink-0 text-sm font-semibold text-foreground">
              {formatPercent(currentContextWindow.remainingPercentage)} left
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            {(currentContextWindow.maxTokens ?? null) !== null
              ? `${formatContextWindowTokens(currentContextWindow.usedTokens)} / ${formatContextWindowTokens(
                  currentContextWindow.maxTokens ?? null,
                )} context used`
              : `${formatContextWindowTokens(currentContextWindow.usedTokens)} tokens used so far`}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {usage.loginMethod ? <span>Login: {usage.loginMethod}</span> : null}
        {usage.version ? <span>CLI: {usage.version}</span> : null}
        {usage.updatedAt ? (
          <span>Updated: {new Date(usage.updatedAt).toLocaleTimeString()}</span>
        ) : null}
      </div>
    </div>
  );
}

export function SidebarCodexUsageControl(props: {
  isMobile: boolean;
  currentThreadTitle: string | null;
  currentContextWindow: ContextWindowSnapshot | null;
}) {
  const { isMobile, currentThreadTitle, currentContextWindow } = props;
  const [open, setOpen] = useState(false);
  const query = useQuery({
    ...serverCodexUsageQueryOptions(),
    enabled: open,
  });

  const primaryLeftPercent = useMemo(() => {
    const providers = [
      ...(query.data ? [query.data] : []),
      ...(query.data?.additionalProviders ?? []),
    ].filter((provider) => provider.available);
    const percentages = providers
      .map((provider) => provider.primary?.leftPercent ?? null)
      .filter((value): value is number => value !== null && Number.isFinite(value));
    return percentages.length > 0 ? Math.min(...percentages) : null;
  }, [query.data]);
  const hasAvailableUsage = Boolean(
    query.data?.available ||
    query.data?.additionalProviders?.some((provider) => provider.available),
  );
  const triggerClassName = useMemo(
    () => triggerToneClass(primaryLeftPercent, query.data ? hasAvailableUsage : null),
    [hasAvailableUsage, primaryLeftPercent, query.data],
  );

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        openOnHover={!isMobile}
        delay={120}
        closeDelay={80}
        render={
          <button
            type="button"
            aria-label="Show Codex usage"
            className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors ${triggerClassName}`}
          />
        }
      >
        <ActivityIcon className="size-3.5 shrink-0" />
        <span>{formatPercent(primaryLeftPercent)}</span>
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-[min(22rem,calc(100vw-1.5rem))] p-0"
      >
        <div className="p-4">
          <CodexUsageContent
            isLoading={query.isLoading}
            usage={query.data}
            currentThreadTitle={currentThreadTitle}
            currentContextWindow={currentContextWindow}
            isRefetching={query.isFetching}
            onRefresh={() => {
              void query.refetch();
            }}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
