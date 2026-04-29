import {
  type OrchestrationEvent,
  type OrchestrationBootstrapReadModel,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type ProjectId,
  type ProviderKind,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationCheckpointSummary,
  type OrchestrationThread,
  type OrchestrationThreadSummary,
  type OrchestrationThreadSnapshot,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import { resolveModelSlugForProvider } from "@t3tools/shared/model";
import {
  retainMostRecentItems,
  SNAPSHOT_MAX_THREAD_ACTIVITIES,
  SNAPSHOT_MAX_THREAD_CHECKPOINTS,
  SNAPSHOT_MAX_THREAD_MESSAGES,
  SNAPSHOT_MAX_THREAD_PROPOSED_PLANS,
} from "@t3tools/shared/threadRetention";
import { create } from "zustand";
import {
  findLatestProposedPlan,
  hasActionableProposedPlan,
  hasLocallyActiveLatestTurn,
  derivePendingApprovals,
  derivePendingUserInputs,
} from "./session-logic";
import { sanitizeThreadErrorMessage } from "./rpc/transportError";
import { type ChatMessage, type Project, type SidebarThreadSummary, type Thread } from "./types";

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  sidebarThreadsById: Record<string, SidebarThreadSummary>;
  threadIdsByProjectId: Record<string, ThreadId[]>;
  bootstrapComplete: boolean;
}

const initialState: AppState = {
  projects: [],
  threads: [],
  sidebarThreadsById: {},
  threadIdsByProjectId: {},
  bootstrapComplete: false,
};
const MAX_THREAD_MESSAGES = SNAPSHOT_MAX_THREAD_MESSAGES;
const MAX_THREAD_CHECKPOINTS = SNAPSHOT_MAX_THREAD_CHECKPOINTS;
const MAX_THREAD_PROPOSED_PLANS = SNAPSHOT_MAX_THREAD_PROPOSED_PLANS;
const MAX_THREAD_ACTIVITIES = SNAPSHOT_MAX_THREAD_ACTIVITIES;
const EMPTY_THREAD_IDS: ThreadId[] = [];

// ── Pure helpers ──────────────────────────────────────────────────────

function updateThread(
  threads: Thread[],
  threadId: ThreadId,
  updater: (t: Thread) => Thread,
): Thread[] {
  let changed = false;
  const next = threads.map((t) => {
    if (t.id !== threadId) return t;
    const updated = updater(t);
    if (updated !== t) changed = true;
    return updated;
  });
  return changed ? next : threads;
}

function updateProject(
  projects: Project[],
  projectId: Project["id"],
  updater: (project: Project) => Project,
): Project[] {
  let changed = false;
  const next = projects.map((project) => {
    if (project.id !== projectId) {
      return project;
    }
    const updated = updater(project);
    if (updated !== project) {
      changed = true;
    }
    return updated;
  });
  return changed ? next : projects;
}

function normalizeModelSelection<T extends { provider: ProviderKind; model: string }>(
  selection: T,
): T {
  return {
    ...selection,
    model: resolveModelSlugForProvider(selection.provider, selection.model),
  };
}

function mapProjectScripts(scripts: ReadonlyArray<Project["scripts"][number]>): Project["scripts"] {
  return scripts.map((script) => ({ ...script }));
}

function mapSession(session: OrchestrationSession): Thread["session"] {
  return {
    provider: toLegacyProvider(session.providerName),
    status: toLegacySessionStatus(session.status),
    orchestrationStatus: session.status,
    activeTurnId: session.activeTurnId ?? undefined,
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    ...(session.lastError ? { lastError: session.lastError } : {}),
  };
}

function shouldTreatSessionAsStaleRunning(input: {
  session: Thread["session"];
  latestTurn: Thread["latestTurn"];
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "streaming" | "turnId">>;
}): boolean {
  if (
    input.session?.status !== "running" ||
    input.session.activeTurnId === undefined ||
    input.latestTurn?.turnId !== input.session.activeTurnId ||
    input.latestTurn.completedAt === null
  ) {
    return false;
  }

  return !input.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.turnId === input.session?.activeTurnId &&
      message.streaming,
  );
}

function normalizeSessionAgainstLatestTurn(input: {
  session: Thread["session"];
  latestTurn: Thread["latestTurn"];
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "streaming" | "turnId">>;
}): Thread["session"] {
  if (!input.session || !shouldTreatSessionAsStaleRunning(input)) {
    return input.session;
  }

  return {
    ...input.session,
    status: "ready",
    orchestrationStatus: "ready",
    activeTurnId: undefined,
  };
}

function mapMessage(message: OrchestrationMessage): ChatMessage {
  const attachments = message.attachments?.map((attachment) => ({
    type: "image" as const,
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    previewUrl: toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachment.id)),
  }));

  return {
    id: message.id,
    role: message.role,
    text: message.text,
    turnId: message.turnId,
    createdAt: message.createdAt,
    streaming: message.streaming,
    ...(message.streaming ? {} : { completedAt: message.updatedAt }),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

function mapProposedPlan(proposedPlan: OrchestrationProposedPlan): Thread["proposedPlans"][number] {
  return {
    id: proposedPlan.id,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
    dismissedAt: proposedPlan.dismissedAt,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
  };
}

function mapTurnDiffSummary(
  checkpoint: OrchestrationCheckpointSummary,
): Thread["turnDiffSummaries"][number] {
  return {
    turnId: checkpoint.turnId,
    completedAt: checkpoint.completedAt,
    status: checkpoint.status,
    assistantMessageId: checkpoint.assistantMessageId ?? undefined,
    checkpointTurnCount: checkpoint.checkpointTurnCount,
    checkpointRef: checkpoint.checkpointRef,
    files: checkpoint.files.map((file) => ({ ...file })),
  };
}

function mergeByKey<T>(
  base: ReadonlyArray<T>,
  overlay: ReadonlyArray<T>,
  getKey: (item: T) => string,
): T[] {
  const merged = new Map<string, T>();
  for (const item of base) {
    merged.set(getKey(item), item);
  }
  for (const item of overlay) {
    merged.set(getKey(item), item);
  }
  return Array.from(merged.values());
}

function mergeMessage(
  snapshotMessage: Thread["messages"][number],
  existingMessage: Thread["messages"][number],
): Thread["messages"][number] {
  const snapshotCompletedAt = snapshotMessage.completedAt;
  const existingCompletedAt = existingMessage.completedAt;
  const snapshotIsFinal = !snapshotMessage.streaming || snapshotCompletedAt !== undefined;
  const existingIsFinal = !existingMessage.streaming || existingCompletedAt !== undefined;

  let preferred = existingMessage;
  let fallback = snapshotMessage;

  if (snapshotIsFinal !== existingIsFinal) {
    preferred = snapshotIsFinal ? snapshotMessage : existingMessage;
    fallback = snapshotIsFinal ? existingMessage : snapshotMessage;
  } else if (snapshotCompletedAt !== undefined || existingCompletedAt !== undefined) {
    const preferredSnapshot =
      snapshotCompletedAt !== undefined &&
      (existingCompletedAt === undefined || snapshotCompletedAt >= existingCompletedAt);
    preferred = preferredSnapshot ? snapshotMessage : existingMessage;
    fallback = preferredSnapshot ? existingMessage : snapshotMessage;
  } else if (snapshotMessage.text.length > existingMessage.text.length) {
    preferred = snapshotMessage;
    fallback = existingMessage;
  }

  const mergedCompletedAt =
    snapshotCompletedAt !== undefined &&
    (existingCompletedAt === undefined || snapshotCompletedAt >= existingCompletedAt)
      ? snapshotCompletedAt
      : existingCompletedAt;

  return {
    ...fallback,
    ...preferred,
    text: preferred.text.length >= fallback.text.length ? preferred.text : fallback.text,
    createdAt:
      snapshotMessage.createdAt <= existingMessage.createdAt
        ? snapshotMessage.createdAt
        : existingMessage.createdAt,
    streaming: mergedCompletedAt !== undefined ? false : preferred.streaming,
    ...((preferred.turnId ?? fallback.turnId) !== undefined
      ? { turnId: preferred.turnId ?? fallback.turnId }
      : {}),
    ...((preferred.attachments ?? fallback.attachments) !== undefined
      ? { attachments: preferred.attachments ?? fallback.attachments }
      : {}),
    ...(mergedCompletedAt !== undefined ? { completedAt: mergedCompletedAt } : {}),
  };
}

function mergeMessages(
  snapshotMessages: Thread["messages"],
  existingMessages: Thread["messages"],
): Thread["messages"] {
  const merged = new Map<string, Thread["messages"][number]>();

  for (const message of snapshotMessages) {
    merged.set(message.id, message);
  }
  for (const message of existingMessages) {
    const existing = merged.get(message.id);
    merged.set(message.id, existing ? mergeMessage(existing, message) : message);
  }

  return Array.from(merged.values()).toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

function mergeProposedPlans(
  snapshotPlans: Thread["proposedPlans"],
  existingPlans: Thread["proposedPlans"],
): Thread["proposedPlans"] {
  return mergeByKey(snapshotPlans, existingPlans, (plan) => plan.id).toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

function mergeTurnDiffSummaries(
  snapshotSummaries: Thread["turnDiffSummaries"],
  existingSummaries: Thread["turnDiffSummaries"],
): Thread["turnDiffSummaries"] {
  return mergeByKey(snapshotSummaries, existingSummaries, (summary) => summary.turnId).toSorted(
    (left, right) =>
      (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
        (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) ||
      left.completedAt.localeCompare(right.completedAt) ||
      left.turnId.localeCompare(right.turnId),
  );
}

function mergeActivities(
  snapshotActivities: Thread["activities"],
  existingActivities: Thread["activities"],
): Thread["activities"] {
  return mergeByKey(snapshotActivities, existingActivities, (activity) => activity.id).toSorted(
    compareActivities,
  );
}

function deriveThreadSummaryState(input: {
  latestTurn: Thread["latestTurn"];
  session: Thread["session"];
  messages: Thread["messages"];
  activities: Thread["activities"];
  proposedPlans: Thread["proposedPlans"];
}): Pick<
  Thread,
  | "latestUserMessageAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "hasLocallyActiveLatestTurn"
> {
  return {
    latestUserMessageAt: getLatestUserMessageAt(input.messages),
    hasPendingApprovals: derivePendingApprovals(input.activities).length > 0,
    hasPendingUserInput: derivePendingUserInputs(input.activities).length > 0,
    hasActionableProposedPlan: hasActionableProposedPlan(
      findLatestProposedPlan(input.proposedPlans, input.latestTurn?.turnId ?? null),
    ),
    hasLocallyActiveLatestTurn: hasLocallyActiveLatestTurn({
      latestTurn: input.latestTurn,
      session: input.session,
      messages: input.messages,
      activities: input.activities,
    }),
  };
}

function mapThread(thread: OrchestrationThread): Thread {
  const session = thread.session ? mapSession(thread.session) : null;
  const messages = Array.from(
    retainMostRecentItems(thread.messages, MAX_THREAD_MESSAGES),
    mapMessage,
  );
  const proposedPlans = Array.from(
    retainMostRecentItems(thread.proposedPlans, MAX_THREAD_PROPOSED_PLANS),
    mapProposedPlan,
  );
  const turnDiffSummaries = Array.from(
    retainMostRecentItems(thread.checkpoints, MAX_THREAD_CHECKPOINTS),
    mapTurnDiffSummary,
  );
  const activities = Array.from(
    retainMostRecentItems(thread.activities, MAX_THREAD_ACTIVITIES),
    (activity) => ({ ...activity }),
  );
  const latestTurn = thread.latestTurn;
  const normalizedSession = normalizeSessionAgainstLatestTurn({
    session,
    latestTurn,
    messages,
  });
  const summaryState = deriveThreadSummaryState({
    latestTurn,
    session: normalizedSession,
    messages,
    activities,
    proposedPlans,
  });

  return {
    id: thread.id,
    codexThreadId: null,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: normalizeModelSelection(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    autoDeferUntil: thread.autoDeferUntil,
    session: normalizedSession,
    messages,
    hasMoreMessagesBefore: thread.hasMoreMessagesBefore ?? false,
    proposedPlans,
    error: sanitizeThreadErrorMessage(normalizedSession?.lastError),
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    latestTurn,
    pendingSourceProposedPlan: latestTurn?.sourceProposedPlan,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    turnDiffSummaries,
    activities,
    detailState: "ready",
    ...summaryState,
  };
}

function mergeThreadSnapshot(
  existing: Thread,
  snapshotThread: Thread,
  options: { partialMessagePage: boolean },
): Thread {
  const snapshotIsStale =
    existing.updatedAt !== undefined &&
    snapshotThread.updatedAt !== undefined &&
    existing.updatedAt > snapshotThread.updatedAt;
  const snapshotMessageIds = new Set(snapshotThread.messages.map((message) => message.id));
  const existingHasMessagesOutsideSnapshot = existing.messages.some(
    (message) => !snapshotMessageIds.has(message.id),
  );
  const shouldPreserveExistingMessages =
    options.partialMessagePage ||
    (snapshotThread.hasMoreMessagesBefore === true && existingHasMessagesOutsideSnapshot);

  if (!snapshotIsStale && !shouldPreserveExistingMessages) {
    return snapshotThread;
  }

  const messages = mergeMessages(snapshotThread.messages, existing.messages).slice(
    -MAX_THREAD_MESSAGES,
  );
  const proposedPlans = mergeProposedPlans(
    snapshotThread.proposedPlans,
    existing.proposedPlans,
  ).slice(-MAX_THREAD_PROPOSED_PLANS);
  const turnDiffSummaries = mergeTurnDiffSummaries(
    snapshotThread.turnDiffSummaries,
    existing.turnDiffSummaries,
  ).slice(-MAX_THREAD_CHECKPOINTS);
  const activities = mergeActivities(snapshotThread.activities, existing.activities).slice(
    -MAX_THREAD_ACTIVITIES,
  );
  const latestTurn = existing.latestTurn;
  const session = existing.session;
  const summaryState = deriveThreadSummaryState({
    latestTurn,
    session,
    messages,
    activities,
    proposedPlans,
  });

  return {
    ...snapshotThread,
    title: existing.title,
    modelSelection: existing.modelSelection,
    runtimeMode: existing.runtimeMode,
    interactionMode: existing.interactionMode,
    autoDeferUntil: existing.autoDeferUntil,
    session,
    messages,
    hasMoreMessagesBefore: snapshotThread.hasMoreMessagesBefore ?? false,
    proposedPlans,
    error: existing.error,
    archivedAt: existing.archivedAt,
    updatedAt: existing.updatedAt,
    latestTurn,
    pendingSourceProposedPlan:
      existing.pendingSourceProposedPlan ?? snapshotThread.pendingSourceProposedPlan,
    branch: existing.branch,
    worktreePath: existing.worktreePath,
    turnDiffSummaries,
    activities,
    detailState: "ready",
    ...summaryState,
  };
}

function mapThreadSummary(thread: OrchestrationThreadSummary): Thread {
  const latestTurn = thread.latestTurn;
  const session = normalizeSessionAgainstLatestTurn({
    session: thread.session ? mapSession(thread.session) : null,
    latestTurn,
    messages: [],
  });
  return {
    id: thread.id,
    codexThreadId: null,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: normalizeModelSelection(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    autoDeferUntil: thread.autoDeferUntil,
    session,
    messages: [],
    hasMoreMessagesBefore: false,
    proposedPlans: [],
    error: sanitizeThreadErrorMessage(session?.lastError),
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    latestTurn,
    pendingSourceProposedPlan: latestTurn?.sourceProposedPlan,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    turnDiffSummaries: [],
    activities: [],
    detailState: "summary",
    latestUserMessageAt: thread.latestUserMessageAt,
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
    hasLocallyActiveLatestTurn: thread.hasLocallyActiveLatestTurn,
  };
}

function mergeThreadSummary(existing: Thread, summaryThread: Thread): Thread {
  const summaryIsStale =
    existing.updatedAt !== undefined &&
    summaryThread.updatedAt !== undefined &&
    existing.updatedAt > summaryThread.updatedAt;

  if (summaryIsStale) {
    return existing;
  }

  if (existing.detailState === "ready") {
    return Object.assign({}, existing, {
      title: summaryThread.title,
      modelSelection: summaryThread.modelSelection,
      runtimeMode: summaryThread.runtimeMode,
      interactionMode: summaryThread.interactionMode,
      autoDeferUntil: summaryThread.autoDeferUntil,
      session: summaryThread.session,
      error: summaryThread.error,
      updatedAt: summaryThread.updatedAt,
      archivedAt: summaryThread.archivedAt,
      latestTurn: summaryThread.latestTurn,
      pendingSourceProposedPlan: summaryThread.pendingSourceProposedPlan,
      branch: summaryThread.branch,
      worktreePath: summaryThread.worktreePath,
      latestUserMessageAt: summaryThread.latestUserMessageAt,
      hasPendingApprovals: summaryThread.hasPendingApprovals,
      hasPendingUserInput: summaryThread.hasPendingUserInput,
      hasActionableProposedPlan: summaryThread.hasActionableProposedPlan,
      hasLocallyActiveLatestTurn: summaryThread.hasLocallyActiveLatestTurn,
    });
  }

  if (existing.detailState !== undefined) {
    return {
      ...summaryThread,
      detailState: existing.detailState,
    };
  }

  return summaryThread;
}

function mapProject(project: OrchestrationReadModel["projects"][number]): Project {
  return {
    id: project.id,
    name: project.title,
    cwd: project.workspaceRoot,
    location: project.location,
    defaultModelSelection: project.defaultModelSelection
      ? normalizeModelSelection(project.defaultModelSelection)
      : null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    scripts: mapProjectScripts(project.scripts),
  };
}

function getLatestUserMessageAt(
  messages: ReadonlyArray<Thread["messages"][number]>,
): string | null {
  let latestUserMessageAt: string | null = null;

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    if (latestUserMessageAt === null || message.createdAt > latestUserMessageAt) {
      latestUserMessageAt = message.createdAt;
    }
  }

  return latestUserMessageAt;
}

function buildSidebarThreadSummary(thread: Thread): SidebarThreadSummary {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    interactionMode: thread.interactionMode,
    autoDeferUntil: thread.autoDeferUntil,
    session: thread.session,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    hasLocallyActiveLatestTurn:
      thread.hasLocallyActiveLatestTurn ??
      hasLocallyActiveLatestTurn({
        latestTurn: thread.latestTurn,
        session: thread.session,
        messages: thread.messages,
        activities: thread.activities,
      }),
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestUserMessageAt: thread.latestUserMessageAt ?? getLatestUserMessageAt(thread.messages),
    hasPendingApprovals:
      thread.hasPendingApprovals ?? derivePendingApprovals(thread.activities).length > 0,
    hasPendingUserInput:
      thread.hasPendingUserInput ?? derivePendingUserInputs(thread.activities).length > 0,
    hasActionableProposedPlan:
      thread.hasActionableProposedPlan ??
      hasActionableProposedPlan(
        findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null),
      ),
  };
}

function sidebarThreadSummariesEqual(
  left: SidebarThreadSummary | undefined,
  right: SidebarThreadSummary,
): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.title === right.title &&
    left.interactionMode === right.interactionMode &&
    left.autoDeferUntil === right.autoDeferUntil &&
    left.session === right.session &&
    left.createdAt === right.createdAt &&
    left.archivedAt === right.archivedAt &&
    left.updatedAt === right.updatedAt &&
    left.latestTurn === right.latestTurn &&
    left.hasLocallyActiveLatestTurn === right.hasLocallyActiveLatestTurn &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.latestUserMessageAt === right.latestUserMessageAt &&
    left.hasPendingApprovals === right.hasPendingApprovals &&
    left.hasPendingUserInput === right.hasPendingUserInput &&
    left.hasActionableProposedPlan === right.hasActionableProposedPlan
  );
}

function appendThreadIdByProjectId(
  threadIdsByProjectId: Record<string, ThreadId[]>,
  projectId: ProjectId,
  threadId: ThreadId,
): Record<string, ThreadId[]> {
  const existingThreadIds = threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS;
  if (existingThreadIds.includes(threadId)) {
    return threadIdsByProjectId;
  }
  return {
    ...threadIdsByProjectId,
    [projectId]: [...existingThreadIds, threadId],
  };
}

function removeThreadIdByProjectId(
  threadIdsByProjectId: Record<string, ThreadId[]>,
  projectId: ProjectId,
  threadId: ThreadId,
): Record<string, ThreadId[]> {
  const existingThreadIds = threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS;
  if (!existingThreadIds.includes(threadId)) {
    return threadIdsByProjectId;
  }
  const nextThreadIds = existingThreadIds.filter(
    (existingThreadId) => existingThreadId !== threadId,
  );
  if (nextThreadIds.length === existingThreadIds.length) {
    return threadIdsByProjectId;
  }
  if (nextThreadIds.length === 0) {
    const nextThreadIdsByProjectId = { ...threadIdsByProjectId };
    delete nextThreadIdsByProjectId[projectId];
    return nextThreadIdsByProjectId;
  }
  return {
    ...threadIdsByProjectId,
    [projectId]: nextThreadIds,
  };
}

function buildThreadIdsByProjectId(threads: ReadonlyArray<Thread>): Record<string, ThreadId[]> {
  const threadIdsByProjectId: Record<string, ThreadId[]> = {};
  for (const thread of threads) {
    const existingThreadIds = threadIdsByProjectId[thread.projectId] ?? EMPTY_THREAD_IDS;
    threadIdsByProjectId[thread.projectId] = [...existingThreadIds, thread.id];
  }
  return threadIdsByProjectId;
}

function buildSidebarThreadsById(
  threads: ReadonlyArray<Thread>,
): Record<string, SidebarThreadSummary> {
  return Object.fromEntries(
    threads.map((thread) => [thread.id, buildSidebarThreadSummary(thread)]),
  );
}

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") {
    return "error" as const;
  }
  if (status === "missing") {
    return "interrupted" as const;
  }
  return "completed" as const;
}

function compareActivities(
  left: Thread["activities"][number],
  right: Thread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function buildLatestTurn(params: {
  previous: Thread["latestTurn"];
  turnId: NonNullable<Thread["latestTurn"]>["turnId"];
  state: NonNullable<Thread["latestTurn"]>["state"];
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"];
  sourceProposedPlan?: Thread["pendingSourceProposedPlan"];
}): NonNullable<Thread["latestTurn"]> {
  const resolvedPlan =
    params.previous?.turnId === params.turnId
      ? params.previous.sourceProposedPlan
      : params.sourceProposedPlan;
  return {
    turnId: params.turnId,
    state: params.state,
    requestedAt: params.requestedAt,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    assistantMessageId: params.assistantMessageId,
    ...(resolvedPlan ? { sourceProposedPlan: resolvedPlan } : {}),
  };
}

function rebindTurnDiffSummariesForAssistantMessage(
  turnDiffSummaries: ReadonlyArray<Thread["turnDiffSummaries"][number]>,
  turnId: Thread["turnDiffSummaries"][number]["turnId"],
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"],
): Thread["turnDiffSummaries"] {
  let changed = false;
  const nextSummaries = turnDiffSummaries.map((summary) => {
    if (summary.turnId !== turnId || summary.assistantMessageId === assistantMessageId) {
      return summary;
    }
    changed = true;
    return {
      ...summary,
      assistantMessageId: assistantMessageId ?? undefined,
    };
  });
  return changed ? nextSummaries : [...turnDiffSummaries];
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<ChatMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ChatMessage[] {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (
      message.turnId !== undefined &&
      message.turnId !== null &&
      retainedTurnIds.has(message.turnId)
    ) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<Thread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["activities"] {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<Thread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["proposedPlans"] {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): ProviderKind {
  if (
    providerName === "codex" ||
    providerName === "claudeAgent" ||
    providerName === "copilot" ||
    providerName === "opencode"
  ) {
    return providerName;
  }
  return "codex";
}

function resolveWsHttpOrigin(): string {
  if (typeof window === "undefined") return "";
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  if (!wsCandidate) return window.location.origin;
  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return window.location.origin;
  }
}

function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return `${resolveWsHttpOrigin()}${rawUrl}`;
  }
  return rawUrl;
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

function updateThreadState(
  state: AppState,
  threadId: ThreadId,
  updater: (thread: Thread) => Thread,
): AppState {
  let updatedThread: Thread | null = null;
  const threads = updateThread(state.threads, threadId, (thread) => {
    const nextThread = updater(thread);
    if (nextThread !== thread) {
      updatedThread = nextThread;
    }
    return nextThread;
  });
  if (threads === state.threads || updatedThread === null) {
    return state;
  }

  const nextSummary = buildSidebarThreadSummary(updatedThread);
  const previousSummary = state.sidebarThreadsById[threadId];
  const sidebarThreadsById = sidebarThreadSummariesEqual(previousSummary, nextSummary)
    ? state.sidebarThreadsById
    : {
        ...state.sidebarThreadsById,
        [threadId]: nextSummary,
      };

  if (sidebarThreadsById === state.sidebarThreadsById) {
    return {
      ...state,
      threads,
    };
  }

  return {
    ...state,
    threads,
    sidebarThreadsById,
  };
}

// ── Pure state transition functions ────────────────────────────────────

export function syncServerReadModel(state: AppState, readModel: OrchestrationReadModel): AppState {
  const projects = readModel.projects
    .filter((project) => project.deletedAt === null)
    .map(mapProject);
  const threads = readModel.threads.filter((thread) => thread.deletedAt === null).map(mapThread);
  const sidebarThreadsById = buildSidebarThreadsById(threads);
  const threadIdsByProjectId = buildThreadIdsByProjectId(threads);
  return {
    ...state,
    projects,
    threads,
    sidebarThreadsById,
    threadIdsByProjectId,
    bootstrapComplete: true,
  };
}

export function syncBootstrapReadModel(
  state: AppState,
  readModel: OrchestrationBootstrapReadModel,
): AppState {
  const projects = readModel.projects
    .filter((project) => project.deletedAt === null)
    .map(mapProject);
  const existingThreadsById = new Map(state.threads.map((thread) => [thread.id, thread] as const));
  const threads = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) => {
      const existing = existingThreadsById.get(thread.id);
      const nextSummaryThread = mapThreadSummary(thread);
      if (existing) {
        return mergeThreadSummary(existing, nextSummaryThread);
      }
      return nextSummaryThread;
    });
  const sidebarThreadsById = buildSidebarThreadsById(threads);
  const threadIdsByProjectId = buildThreadIdsByProjectId(threads);
  return {
    ...state,
    projects,
    threads,
    sidebarThreadsById,
    threadIdsByProjectId,
    bootstrapComplete: true,
  };
}

export function syncThreadSnapshot(
  state: AppState,
  snapshot: OrchestrationThreadSnapshot,
): AppState {
  if (snapshot.thread === null) {
    return state;
  }
  const nextThread = mapThread(snapshot.thread);
  const existing = state.threads.find((thread) => thread.id === nextThread.id);
  const mergedThread = existing
    ? mergeThreadSnapshot(existing, nextThread, {
        partialMessagePage: snapshot.messageWindow?.beforeMessageId != null,
      })
    : nextThread;
  const threads = existing
    ? state.threads.map((thread) => (thread.id === mergedThread.id ? mergedThread : thread))
    : [...state.threads, mergedThread];
  const nextSummary = buildSidebarThreadSummary(mergedThread);
  const previousSummary = state.sidebarThreadsById[mergedThread.id];
  const sidebarThreadsById = sidebarThreadSummariesEqual(previousSummary, nextSummary)
    ? state.sidebarThreadsById
    : {
        ...state.sidebarThreadsById,
        [mergedThread.id]: nextSummary,
      };
  const threadIdsByProjectId = appendThreadIdByProjectId(
    state.threadIdsByProjectId,
    mergedThread.projectId,
    mergedThread.id,
  );

  return {
    ...state,
    threads,
    sidebarThreadsById,
    threadIdsByProjectId,
  };
}

export function applyOrchestrationEvent(state: AppState, event: OrchestrationEvent): AppState {
  const nextState = (() => {
    switch (event.type) {
      case "project.created": {
        const existingIndex = state.projects.findIndex(
          (project) =>
            project.id === event.payload.projectId || project.cwd === event.payload.workspaceRoot,
        );
        const nextProject = mapProject({
          id: event.payload.projectId,
          title: event.payload.title,
          workspaceRoot: event.payload.workspaceRoot,
          location: event.payload.location,
          defaultModelSelection: event.payload.defaultModelSelection,
          scripts: event.payload.scripts,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          deletedAt: null,
        });
        const projects =
          existingIndex >= 0
            ? state.projects.map((project, index) =>
                index === existingIndex ? nextProject : project,
              )
            : [...state.projects, nextProject];
        return { ...state, projects };
      }

      case "project.meta-updated": {
        const projects = updateProject(state.projects, event.payload.projectId, (project) => ({
          ...project,
          ...(event.payload.title !== undefined ? { name: event.payload.title } : {}),
          ...(event.payload.workspaceRoot !== undefined
            ? { cwd: event.payload.workspaceRoot }
            : {}),
          ...(event.payload.location !== undefined ? { location: event.payload.location } : {}),
          ...(event.payload.defaultModelSelection !== undefined
            ? {
                defaultModelSelection: event.payload.defaultModelSelection
                  ? normalizeModelSelection(event.payload.defaultModelSelection)
                  : null,
              }
            : {}),
          ...(event.payload.scripts !== undefined
            ? { scripts: mapProjectScripts(event.payload.scripts) }
            : {}),
          updatedAt: event.payload.updatedAt,
        }));
        return projects === state.projects ? state : { ...state, projects };
      }

      case "project.deleted": {
        const projects = state.projects.filter((project) => project.id !== event.payload.projectId);
        return projects.length === state.projects.length ? state : { ...state, projects };
      }

      case "thread.created": {
        const existing = state.threads.find((thread) => thread.id === event.payload.threadId);
        const nextThread = mapThread({
          id: event.payload.threadId,
          projectId: event.payload.projectId,
          title: event.payload.title,
          modelSelection: event.payload.modelSelection,
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          autoDeferUntil: event.payload.autoDeferUntil,
          consecutiveAutoNoops: event.payload.consecutiveAutoNoops,
          branch: event.payload.branch,
          worktreePath: event.payload.worktreePath,
          latestTurn: null,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          archivedAt: null,
          deletedAt: null,
          messages: [],
          hasMoreMessagesBefore: false,
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        });
        const threads = existing
          ? state.threads.map((thread) => (thread.id === nextThread.id ? nextThread : thread))
          : [...state.threads, nextThread];
        const nextSummary = buildSidebarThreadSummary(nextThread);
        const previousSummary = state.sidebarThreadsById[nextThread.id];
        const sidebarThreadsById = sidebarThreadSummariesEqual(previousSummary, nextSummary)
          ? state.sidebarThreadsById
          : {
              ...state.sidebarThreadsById,
              [nextThread.id]: nextSummary,
            };
        const nextThreadIdsByProjectId =
          existing !== undefined && existing.projectId !== nextThread.projectId
            ? removeThreadIdByProjectId(state.threadIdsByProjectId, existing.projectId, existing.id)
            : state.threadIdsByProjectId;
        const threadIdsByProjectId = appendThreadIdByProjectId(
          nextThreadIdsByProjectId,
          nextThread.projectId,
          nextThread.id,
        );
        return {
          ...state,
          threads,
          sidebarThreadsById,
          threadIdsByProjectId,
        };
      }

      case "thread.deleted": {
        const threads = state.threads.filter((thread) => thread.id !== event.payload.threadId);
        if (threads.length === state.threads.length) {
          return state;
        }
        const deletedThread = state.threads.find((thread) => thread.id === event.payload.threadId);
        const sidebarThreadsById = { ...state.sidebarThreadsById };
        delete sidebarThreadsById[event.payload.threadId];
        const threadIdsByProjectId = deletedThread
          ? removeThreadIdByProjectId(
              state.threadIdsByProjectId,
              deletedThread.projectId,
              deletedThread.id,
            )
          : state.threadIdsByProjectId;
        return {
          ...state,
          threads,
          sidebarThreadsById,
          threadIdsByProjectId,
        };
      }

      case "thread.archived": {
        return updateThreadState(state, event.payload.threadId, (thread) => ({
          ...thread,
          archivedAt: event.payload.archivedAt,
          updatedAt: event.payload.updatedAt,
        }));
      }

      case "thread.unarchived": {
        return updateThreadState(state, event.payload.threadId, (thread) => ({
          ...thread,
          archivedAt: null,
          updatedAt: event.payload.updatedAt,
        }));
      }

      case "thread.meta-updated": {
        return updateThreadState(state, event.payload.threadId, (thread) => ({
          ...thread,
          ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
            : {}),
          ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
          ...(event.payload.worktreePath !== undefined
            ? { worktreePath: event.payload.worktreePath }
            : {}),
          updatedAt: event.payload.updatedAt,
        }));
      }

      case "thread.runtime-mode-set": {
        return updateThreadState(state, event.payload.threadId, (thread) => ({
          ...thread,
          runtimeMode: event.payload.runtimeMode,
          updatedAt: event.payload.updatedAt,
        }));
      }

      case "thread.interaction-mode-set": {
        return updateThreadState(state, event.payload.threadId, (thread) => ({
          ...thread,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.payload.updatedAt,
        }));
      }

      case "thread.turn-start-requested": {
        return updateThreadState(state, event.payload.threadId, (thread) => ({
          ...thread,
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
            : {}),
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          pendingSourceProposedPlan: event.payload.sourceProposedPlan,
          updatedAt: event.occurredAt,
        }));
      }

      case "thread.turn-interrupt-requested": {
        if (event.payload.turnId === undefined) {
          return state;
        }
        return updateThreadState(state, event.payload.threadId, (thread) => {
          const latestTurn = thread.latestTurn;
          if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
            return thread;
          }
          return {
            ...thread,
            latestTurn: buildLatestTurn({
              previous: latestTurn,
              turnId: event.payload.turnId,
              state: "interrupted",
              requestedAt: latestTurn.requestedAt,
              startedAt: latestTurn.startedAt ?? event.payload.createdAt,
              completedAt: latestTurn.completedAt ?? event.payload.createdAt,
              assistantMessageId: latestTurn.assistantMessageId,
            }),
            hasLocallyActiveLatestTurn: true,
            updatedAt: event.occurredAt,
          };
        });
      }

      case "thread.message-sent": {
        return updateThreadState(state, event.payload.threadId, (thread) => {
          const message = mapMessage({
            id: event.payload.messageId,
            role: event.payload.role,
            text: event.payload.text,
            ...(event.payload.attachments !== undefined
              ? { attachments: event.payload.attachments }
              : {}),
            turnId: event.payload.turnId,
            streaming: event.payload.streaming,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          const existingMessage = thread.messages.find((entry) => entry.id === message.id);
          const messages = existingMessage
            ? thread.messages.map((entry) =>
                entry.id !== message.id
                  ? entry
                  : {
                      ...entry,
                      text: message.streaming
                        ? `${entry.text}${message.text}`
                        : message.text.length > 0
                          ? message.text
                          : entry.text,
                      streaming: message.streaming,
                      ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
                      ...(message.streaming
                        ? entry.completedAt !== undefined
                          ? { completedAt: entry.completedAt }
                          : {}
                        : message.completedAt !== undefined
                          ? { completedAt: message.completedAt }
                          : {}),
                      ...(message.attachments !== undefined
                        ? { attachments: message.attachments }
                        : {}),
                    },
              )
            : [...thread.messages, message];
          const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);
          const turnDiffSummaries =
            event.payload.role === "assistant" && event.payload.turnId !== null
              ? rebindTurnDiffSummariesForAssistantMessage(
                  thread.turnDiffSummaries,
                  event.payload.turnId,
                  event.payload.messageId,
                )
              : thread.turnDiffSummaries;
          const latestTurn: Thread["latestTurn"] =
            event.payload.role === "assistant" &&
            event.payload.turnId !== null &&
            (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
              ? buildLatestTurn({
                  previous: thread.latestTurn,
                  turnId: event.payload.turnId,
                  state: event.payload.streaming
                    ? "running"
                    : thread.latestTurn?.state === "interrupted"
                      ? "interrupted"
                      : thread.latestTurn?.state === "error"
                        ? "error"
                        : "completed",
                  requestedAt:
                    thread.latestTurn?.turnId === event.payload.turnId
                      ? thread.latestTurn.requestedAt
                      : event.payload.createdAt,
                  startedAt:
                    thread.latestTurn?.turnId === event.payload.turnId
                      ? (thread.latestTurn.startedAt ?? event.payload.createdAt)
                      : event.payload.createdAt,
                  sourceProposedPlan: thread.pendingSourceProposedPlan,
                  completedAt: event.payload.streaming
                    ? thread.latestTurn?.turnId === event.payload.turnId
                      ? (thread.latestTurn.completedAt ?? null)
                      : null
                    : event.payload.updatedAt,
                  assistantMessageId: event.payload.messageId,
                })
              : thread.latestTurn;
          const session = normalizeSessionAgainstLatestTurn({
            session: thread.session,
            latestTurn,
            messages: cappedMessages,
          });
          return {
            ...thread,
            session,
            messages: cappedMessages,
            turnDiffSummaries,
            latestTurn,
            latestUserMessageAt:
              message.role !== "user"
                ? (thread.latestUserMessageAt ?? null)
                : thread.latestUserMessageAt == null ||
                    message.createdAt > thread.latestUserMessageAt
                  ? message.createdAt
                  : thread.latestUserMessageAt,
            hasLocallyActiveLatestTurn: hasLocallyActiveLatestTurn({
              latestTurn,
              session,
              messages: cappedMessages,
              activities: thread.activities,
            }),
            updatedAt: event.occurredAt,
          };
        });
      }

      case "thread.session-set": {
        return updateThreadState(state, event.payload.threadId, (thread) => {
          const incomingSession = mapSession(event.payload.session);
          const latestTurn =
            event.payload.session.status === "running" &&
            event.payload.session.activeTurnId !== null &&
            !(
              thread.latestTurn?.turnId === event.payload.session.activeTurnId &&
              thread.latestTurn.completedAt !== null
            )
              ? buildLatestTurn({
                  previous: thread.latestTurn,
                  turnId: event.payload.session.activeTurnId,
                  state: "running",
                  requestedAt:
                    thread.latestTurn?.turnId === event.payload.session.activeTurnId
                      ? thread.latestTurn.requestedAt
                      : event.payload.session.updatedAt,
                  startedAt:
                    thread.latestTurn?.turnId === event.payload.session.activeTurnId
                      ? (thread.latestTurn.startedAt ?? event.payload.session.updatedAt)
                      : event.payload.session.updatedAt,
                  completedAt: null,
                  assistantMessageId:
                    thread.latestTurn?.turnId === event.payload.session.activeTurnId
                      ? thread.latestTurn.assistantMessageId
                      : null,
                  sourceProposedPlan: thread.pendingSourceProposedPlan,
                })
              : thread.latestTurn;
          const session = normalizeSessionAgainstLatestTurn({
            session: incomingSession,
            latestTurn,
            messages: thread.messages,
          });
          return {
            ...thread,
            session,
            error: sanitizeThreadErrorMessage(event.payload.session.lastError),
            latestTurn,
            hasLocallyActiveLatestTurn: hasLocallyActiveLatestTurn({
              latestTurn,
              session,
              messages: thread.messages,
              activities: thread.activities,
            }),
            updatedAt: event.occurredAt,
          };
        });
      }

      case "thread.session-stop-requested": {
        return updateThreadState(state, event.payload.threadId, (thread) => {
          if (thread.session === null) {
            return thread;
          }
          const stoppedSession = {
            ...thread.session,
            status: "closed" as const,
            orchestrationStatus: "stopped" as const,
            activeTurnId: undefined,
            updatedAt: event.payload.createdAt,
          };
          return {
            ...thread,
            session: stoppedSession,
            hasLocallyActiveLatestTurn: hasLocallyActiveLatestTurn({
              latestTurn: thread.latestTurn,
              session: stoppedSession,
              messages: thread.messages,
              activities: thread.activities,
            }),
            updatedAt: event.occurredAt,
          };
        });
      }

      case "thread.proposed-plan-upserted": {
        return updateThreadState(state, event.payload.threadId, (thread) => {
          const proposedPlan = mapProposedPlan(event.payload.proposedPlan);
          const proposedPlans = [
            ...thread.proposedPlans.filter((entry) => entry.id !== proposedPlan.id),
            proposedPlan,
          ]
            .toSorted(
              (left, right) =>
                left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
            )
            .slice(-MAX_THREAD_PROPOSED_PLANS);
          return {
            ...thread,
            proposedPlans,
            hasActionableProposedPlan: hasActionableProposedPlan(
              findLatestProposedPlan(proposedPlans, thread.latestTurn?.turnId ?? null),
            ),
            updatedAt: event.occurredAt,
          };
        });
      }

      case "thread.turn-diff-completed": {
        return updateThreadState(state, event.payload.threadId, (thread) => {
          const checkpoint = mapTurnDiffSummary({
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            status: event.payload.status,
            files: event.payload.files,
            assistantMessageId: event.payload.assistantMessageId,
            completedAt: event.payload.completedAt,
          });
          const existing = thread.turnDiffSummaries.find(
            (entry) => entry.turnId === checkpoint.turnId,
          );
          if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
            return thread;
          }
          const turnDiffSummaries = [
            ...thread.turnDiffSummaries.filter((entry) => entry.turnId !== checkpoint.turnId),
            checkpoint,
          ]
            .toSorted(
              (left, right) =>
                (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
                (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
            )
            .slice(-MAX_THREAD_CHECKPOINTS);
          const latestTurn =
            thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId
              ? buildLatestTurn({
                  previous: thread.latestTurn,
                  turnId: event.payload.turnId,
                  state: checkpointStatusToLatestTurnState(event.payload.status),
                  requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
                  startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
                  completedAt: event.payload.completedAt,
                  assistantMessageId: event.payload.assistantMessageId,
                  sourceProposedPlan: thread.pendingSourceProposedPlan,
                })
              : thread.latestTurn;
          const session = normalizeSessionAgainstLatestTurn({
            session: thread.session,
            latestTurn,
            messages: thread.messages,
          });
          return {
            ...thread,
            session,
            turnDiffSummaries,
            latestTurn,
            hasLocallyActiveLatestTurn: hasLocallyActiveLatestTurn({
              latestTurn,
              session,
              messages: thread.messages,
              activities: thread.activities,
            }),
            updatedAt: event.occurredAt,
          };
        });
      }

      case "thread.reverted": {
        return updateThreadState(state, event.payload.threadId, (thread) => {
          const turnDiffSummaries = thread.turnDiffSummaries
            .filter(
              (entry) =>
                entry.checkpointTurnCount !== undefined &&
                entry.checkpointTurnCount <= event.payload.turnCount,
            )
            .toSorted(
              (left, right) =>
                (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
                (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
            )
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set(turnDiffSummaries.map((entry) => entry.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            event.payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-MAX_THREAD_PROPOSED_PLANS);
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);
          const latestCheckpoint = turnDiffSummaries.at(-1) ?? null;

          return {
            ...thread,
            turnDiffSummaries,
            messages,
            proposedPlans,
            activities,
            pendingSourceProposedPlan: undefined,
            latestTurn:
              latestCheckpoint === null
                ? null
                : {
                    turnId: latestCheckpoint.turnId,
                    state: checkpointStatusToLatestTurnState(
                      (latestCheckpoint.status ?? "ready") as "ready" | "missing" | "error",
                    ),
                    requestedAt: latestCheckpoint.completedAt,
                    startedAt: latestCheckpoint.completedAt,
                    completedAt: latestCheckpoint.completedAt,
                    assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                  },
            ...deriveThreadSummaryState({
              latestTurn:
                latestCheckpoint === null
                  ? null
                  : {
                      turnId: latestCheckpoint.turnId,
                      state: checkpointStatusToLatestTurnState(
                        (latestCheckpoint.status ?? "ready") as "ready" | "missing" | "error",
                      ),
                      requestedAt: latestCheckpoint.completedAt,
                      startedAt: latestCheckpoint.completedAt,
                      completedAt: latestCheckpoint.completedAt,
                      assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                    },
              session: thread.session,
              messages,
              activities,
              proposedPlans,
            }),
            updatedAt: event.occurredAt,
          };
        });
      }

      case "thread.activity-appended": {
        return updateThreadState(state, event.payload.threadId, (thread) => {
          const activities = [
            ...thread.activities.filter((activity) => activity.id !== event.payload.activity.id),
            { ...event.payload.activity },
          ]
            .toSorted(compareActivities)
            .slice(-MAX_THREAD_ACTIVITIES);
          return {
            ...thread,
            activities,
            hasPendingApprovals: derivePendingApprovals(activities).length > 0,
            hasPendingUserInput: derivePendingUserInputs(activities).length > 0,
            hasLocallyActiveLatestTurn: hasLocallyActiveLatestTurn({
              latestTurn: thread.latestTurn,
              session: thread.session,
              messages: thread.messages,
              activities,
            }),
            updatedAt: event.occurredAt,
          };
        });
      }

      case "thread.approval-response-requested":
      case "thread.user-input-response-requested":
        return state;
    }

    return state;
  })();

  if (nextState === state) {
    return state;
  }

  return nextState;
}

export function applyOrchestrationEvents(
  state: AppState,
  events: ReadonlyArray<OrchestrationEvent>,
): AppState {
  if (events.length === 0) {
    return state;
  }
  return events.reduce((nextState, event) => applyOrchestrationEvent(nextState, event), state);
}

export const selectProjectById =
  (projectId: Project["id"] | null | undefined) =>
  (state: AppState): Project | undefined =>
    projectId ? state.projects.find((project) => project.id === projectId) : undefined;

export const selectThreadById =
  (threadId: ThreadId | null | undefined) =>
  (state: AppState): Thread | undefined =>
    threadId ? state.threads.find((thread) => thread.id === threadId) : undefined;

export const selectSidebarThreadSummaryById =
  (threadId: ThreadId | null | undefined) =>
  (state: AppState): SidebarThreadSummary | undefined =>
    threadId ? state.sidebarThreadsById[threadId] : undefined;

export const selectThreadIdsByProjectId =
  (projectId: ProjectId | null | undefined) =>
  (state: AppState): ThreadId[] =>
    projectId ? (state.threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS) : EMPTY_THREAD_IDS;

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  return updateThreadState(state, threadId, (t) => {
    if (t.error === error) return t;
    return { ...t, error };
  });
}

export function setThreadBranch(
  state: AppState,
  threadId: ThreadId,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  return updateThreadState(state, threadId, (t) => {
    if (t.branch === branch && t.worktreePath === worktreePath) return t;
    const cwdChanged = t.worktreePath !== worktreePath;
    return {
      ...t,
      branch,
      worktreePath,
      ...(cwdChanged ? { session: null } : {}),
    };
  });
}

export function setThreadDetailState(
  state: AppState,
  threadId: ThreadId,
  detailState: NonNullable<Thread["detailState"]>,
): AppState {
  return updateThreadState(state, threadId, (thread) =>
    thread.detailState === detailState ? thread : { ...thread, detailState },
  );
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  syncBootstrapReadModel: (readModel: OrchestrationBootstrapReadModel) => void;
  syncThreadSnapshot: (snapshot: OrchestrationThreadSnapshot) => void;
  applyOrchestrationEvent: (event: OrchestrationEvent) => void;
  applyOrchestrationEvents: (events: ReadonlyArray<OrchestrationEvent>) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (threadId: ThreadId, branch: string | null, worktreePath: string | null) => void;
  setThreadDetailState: (
    threadId: ThreadId,
    detailState: NonNullable<Thread["detailState"]>,
  ) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...initialState,
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  syncBootstrapReadModel: (readModel) => set((state) => syncBootstrapReadModel(state, readModel)),
  syncThreadSnapshot: (snapshot) => set((state) => syncThreadSnapshot(state, snapshot)),
  applyOrchestrationEvent: (event) => set((state) => applyOrchestrationEvent(state, event)),
  applyOrchestrationEvents: (events) => set((state) => applyOrchestrationEvents(state, events)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadId, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadId, branch, worktreePath)),
  setThreadDetailState: (threadId, detailState) =>
    set((state) => setThreadDetailState(state, threadId, detailState)),
}));
