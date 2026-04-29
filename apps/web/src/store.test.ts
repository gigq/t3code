import {
  CheckpointRef,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationBootstrapReadModel,
  type OrchestrationReadModel,
  type OrchestrationThreadSnapshot,
} from "@t3tools/contracts";
import {
  SNAPSHOT_MAX_THREAD_ACTIVITIES,
  SNAPSHOT_MAX_THREAD_CHECKPOINTS,
  SNAPSHOT_MAX_THREAD_MESSAGES,
  SNAPSHOT_MAX_THREAD_PROPOSED_PLANS,
} from "@t3tools/shared/threadRetention";
import { describe, expect, it } from "vitest";

import {
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  syncBootstrapReadModel,
  syncServerReadModel,
  syncThreadSnapshot,
  type AppState,
} from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    autoDeferUntil: null,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  const threadIdsByProjectId: AppState["threadIdsByProjectId"] = {
    [thread.projectId]: [thread.id],
  };
  return {
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        name: "Project",
        cwd: "/tmp/project",
        location: { kind: "local" },
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        scripts: [],
      },
    ],
    threads: [thread],
    sidebarThreadsById: {},
    threadIdsByProjectId,
    bootstrapComplete: true,
  };
}

function makeEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  overrides: Partial<Extract<OrchestrationEvent, { type: T }>> = {},
): Extract<OrchestrationEvent, { type: T }> {
  const sequence = overrides.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId:
      "threadId" in payload
        ? payload.threadId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.makeUnsafe("project-1"),
    occurredAt: "2026-02-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<OrchestrationEvent, { type: T }>;
}

function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    autoDeferUntil: null,
    consecutiveAutoNoops: 0,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    ...overrides,
  } satisfies OrchestrationReadModel["threads"][number];
}

function makeReadModel(thread: OrchestrationReadModel["threads"][number]): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        location: { kind: "local" },
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
      },
    ],
    threads: [thread],
  };
}

function makeReadModelProject(
  overrides: Partial<OrchestrationReadModel["projects"][number]>,
): OrchestrationReadModel["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    title: "Project",
    workspaceRoot: "/tmp/project",
    location: { kind: "local" },
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    scripts: [],
    ...overrides,
  };
}

describe("store read model sync", () => {
  it("marks bootstrap complete after snapshot sync", () => {
    const initialState: AppState = {
      ...makeState(makeThread()),
      bootstrapComplete: false,
    };

    const next = syncServerReadModel(initialState, makeReadModel(makeReadModelThread({})));

    expect(next.bootstrapComplete).toBe(true);
  });

  it("caps bootstrap snapshot history to the retained per-thread limits", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        messages: Array.from({ length: SNAPSHOT_MAX_THREAD_MESSAGES + 3 }, (_, index) => ({
          id: MessageId.makeUnsafe(`message-${index}`),
          role: "assistant" as const,
          text: `message ${index}`,
          turnId: TurnId.makeUnsafe(`turn-${index}`),
          streaming: false,
          createdAt: `2026-02-27T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
            index % 60,
          ).padStart(2, "0")}.000Z`,
          updatedAt: `2026-02-27T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
            index % 60,
          ).padStart(2, "0")}.000Z`,
        })),
        proposedPlans: Array.from(
          { length: SNAPSHOT_MAX_THREAD_PROPOSED_PLANS + 3 },
          (_, index) => ({
            id: `plan-${index}`,
            turnId: TurnId.makeUnsafe(`turn-${index}`),
            planMarkdown: `# Plan ${index}`,
            implementedAt: null,
            implementationThreadId: null,
            dismissedAt: null,
            createdAt: `2026-02-27T01:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
              index % 60,
            ).padStart(2, "0")}.000Z`,
            updatedAt: `2026-02-27T01:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
              index % 60,
            ).padStart(2, "0")}.000Z`,
          }),
        ),
        activities: Array.from({ length: SNAPSHOT_MAX_THREAD_ACTIVITIES + 3 }, (_, index) => ({
          id: EventId.makeUnsafe(`activity-${index}`),
          turnId: TurnId.makeUnsafe(`turn-${index}`),
          tone: "info" as const,
          kind: "runtime.note",
          summary: `activity ${index}`,
          payload: { index },
          sequence: index,
          createdAt: `2026-02-27T02:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
            index % 60,
          ).padStart(2, "0")}.000Z`,
        })),
        checkpoints: Array.from({ length: SNAPSHOT_MAX_THREAD_CHECKPOINTS + 3 }, (_, index) => ({
          turnId: TurnId.makeUnsafe(`turn-${index}`),
          checkpointTurnCount: index + 1,
          checkpointRef: CheckpointRef.makeUnsafe(`checkpoint-${index}`),
          status: "ready" as const,
          files: [],
          assistantMessageId: MessageId.makeUnsafe(`message-${index}`),
          completedAt: `2026-02-27T03:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
            index % 60,
          ).padStart(2, "0")}.000Z`,
        })),
      }),
    );

    const next = syncServerReadModel(initialState, readModel);
    const thread = next.threads[0];

    expect(thread?.messages).toHaveLength(SNAPSHOT_MAX_THREAD_MESSAGES);
    expect(thread?.messages[0]?.id).toBe("message-3");
    expect(thread?.proposedPlans).toHaveLength(SNAPSHOT_MAX_THREAD_PROPOSED_PLANS);
    expect(thread?.proposedPlans[0]?.id).toBe("plan-3");
    expect(thread?.activities).toHaveLength(SNAPSHOT_MAX_THREAD_ACTIVITIES);
    expect(thread?.activities[0]?.id).toBe("activity-3");
    expect(thread?.turnDiffSummaries).toHaveLength(SNAPSHOT_MAX_THREAD_CHECKPOINTS);
    expect(thread?.turnDiffSummaries[0]?.checkpointRef).toBe("checkpoint-3");
  });

  it("preserves claude model slugs without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-opus-4-6");
  });

  it("resolves claude aliases when session provider is claudeAgent", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "sonnet",
        },
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-sonnet-4-6");
  });

  it("preserves project and thread updatedAt timestamps from the read model", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        updatedAt: "2026-02-27T00:05:00.000Z",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects[0]?.updatedAt).toBe("2026-02-27T00:00:00.000Z");
    expect(next.threads[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
  });

  it("maps archivedAt from the read model", () => {
    const initialState = makeState(makeThread());
    const archivedAt = "2026-02-28T00:00:00.000Z";
    const next = syncServerReadModel(
      initialState,
      makeReadModel(
        makeReadModelThread({
          archivedAt,
        }),
      ),
    );

    expect(next.threads[0]?.archivedAt).toBe(archivedAt);
  });

  it("hydrates summary threads from the bootstrap snapshot and defers detail loading", () => {
    const initialState = makeState(makeThread());
    const bootstrapReadModel: OrchestrationBootstrapReadModel = {
      snapshotSequence: 1,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: makeReadModel(makeReadModelThread({})).projects,
      threads: [
        {
          id: ThreadId.makeUnsafe("thread-1"),
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
          },
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          autoDeferUntil: null,
          consecutiveAutoNoops: 0,
          branch: "main",
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:05:00.000Z",
          archivedAt: null,
          deletedAt: null,
          session: null,
          latestUserMessageAt: "2026-02-27T00:04:00.000Z",
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          hasActionableProposedPlan: true,
          hasLocallyActiveLatestTurn: false,
        },
      ],
    };

    const next = syncBootstrapReadModel(initialState, bootstrapReadModel);

    expect(next.threads[0]?.detailState).toBe("summary");
    expect(next.threads[0]?.messages).toHaveLength(0);
    expect(next.sidebarThreadsById["thread-1"]?.hasPendingApprovals).toBe(true);
    expect(next.sidebarThreadsById["thread-1"]?.hasActionableProposedPlan).toBe(true);
  });

  it("upgrades a summary thread in place when thread detail arrives", () => {
    const initialState = syncBootstrapReadModel(makeState(makeThread()), {
      snapshotSequence: 1,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: makeReadModel(makeReadModelThread({})).projects,
      threads: [
        {
          id: ThreadId.makeUnsafe("thread-1"),
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
          },
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          autoDeferUntil: null,
          consecutiveAutoNoops: 0,
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:05:00.000Z",
          archivedAt: null,
          deletedAt: null,
          session: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          hasLocallyActiveLatestTurn: false,
        },
      ],
    });
    const snapshot: OrchestrationThreadSnapshot = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:06:00.000Z",
      thread: makeReadModelThread({
        messages: [
          {
            id: MessageId.makeUnsafe("message-1"),
            role: "user",
            text: "hello",
            turnId: TurnId.makeUnsafe("turn-1"),
            streaming: false,
            createdAt: "2026-02-27T00:05:30.000Z",
            updatedAt: "2026-02-27T00:05:30.000Z",
          },
        ],
      }),
    };

    const next = syncThreadSnapshot(initialState, snapshot);

    expect(next.threads[0]?.detailState).toBe("ready");
    expect(next.threads[0]?.messages).toHaveLength(1);
    expect(next.sidebarThreadsById["thread-1"]?.latestUserMessageAt).toBe(
      "2026-02-27T00:05:30.000Z",
    );
  });

  it("normalizes stale running sessions in thread snapshots once the latest turn is already completed", () => {
    const state = makeState(makeThread());
    const snapshot: OrchestrationThreadSnapshot = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:06:00.000Z",
      thread: makeReadModelThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:01.000Z",
          completedAt: "2026-02-27T00:00:04.000Z",
          assistantMessageId: MessageId.makeUnsafe("assistant-1"),
        },
        messages: [
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "done",
            turnId: TurnId.makeUnsafe("turn-1"),
            streaming: false,
            createdAt: "2026-02-27T00:00:02.000Z",
            updatedAt: "2026-02-27T00:00:04.000Z",
          },
        ],
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
          lastError: null,
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
      }),
    };

    const next = syncThreadSnapshot(state, snapshot);

    expect(next.threads[0]?.session?.status).toBe("ready");
    expect(next.threads[0]?.session?.activeTurnId).toBeUndefined();
    expect(next.threads[0]?.latestTurn?.state).toBe("completed");
  });

  it("merges stale thread detail snapshots without clobbering newer live events", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");
    const initialState = syncBootstrapReadModel(makeState(makeThread()), {
      snapshotSequence: 1,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: makeReadModel(makeReadModelThread({})).projects,
      threads: [
        {
          id: threadId,
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
          },
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          autoDeferUntil: null,
          consecutiveAutoNoops: 0,
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:05:00.000Z",
          archivedAt: null,
          deletedAt: null,
          session: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          hasLocallyActiveLatestTurn: false,
        },
      ],
    });
    const liveState = applyOrchestrationEvents(initialState, [
      makeEvent(
        "thread.session-set",
        {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-02-27T00:07:00.000Z",
          },
        },
        { occurredAt: "2026-02-27T00:07:00.000Z" },
      ),
      makeEvent(
        "thread.message-sent",
        {
          threadId,
          messageId: MessageId.makeUnsafe("message-live"),
          role: "user",
          text: "latest prompt",
          turnId,
          streaming: false,
          createdAt: "2026-02-27T00:07:01.000Z",
          updatedAt: "2026-02-27T00:07:01.000Z",
        },
        { occurredAt: "2026-02-27T00:07:01.000Z", sequence: 2 },
      ),
    ]);
    const staleSnapshot: OrchestrationThreadSnapshot = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:06:00.000Z",
      thread: makeReadModelThread({
        updatedAt: "2026-02-27T00:06:00.000Z",
        messages: [
          {
            id: MessageId.makeUnsafe("message-older"),
            role: "assistant",
            text: "older context",
            turnId: TurnId.makeUnsafe("turn-older"),
            streaming: false,
            createdAt: "2026-02-27T00:04:00.000Z",
            updatedAt: "2026-02-27T00:04:00.000Z",
          },
        ],
      }),
    };

    const next = syncThreadSnapshot(liveState, staleSnapshot);

    expect(next.threads[0]?.detailState).toBe("ready");
    expect(next.threads[0]?.updatedAt).toBe("2026-02-27T00:07:01.000Z");
    expect(next.threads[0]?.latestTurn).toMatchObject({
      turnId,
      state: "running",
    });
    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("message-older"),
      MessageId.makeUnsafe("message-live"),
    ]);
  });

  it("prefers finalized snapshot messages over stale local streaming copies", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");
    const messageId = MessageId.makeUnsafe("assistant-1");
    const liveState = makeState(
      makeThread({
        id: threadId,
        updatedAt: "2026-02-27T00:07:00.000Z",
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:06:00.000Z",
          startedAt: "2026-02-27T00:06:01.000Z",
          completedAt: "2026-02-27T00:06:04.000Z",
          assistantMessageId: messageId,
        },
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-02-27T00:06:00.000Z",
          updatedAt: "2026-02-27T00:06:04.000Z",
        },
        messages: [
          {
            id: messageId,
            role: "assistant",
            text: "Hello",
            turnId,
            createdAt: "2026-02-27T00:06:02.000Z",
            streaming: true,
          },
        ],
        activities: [],
        hasLocallyActiveLatestTurn: true,
      }),
    );
    const staleSnapshot: OrchestrationThreadSnapshot = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:06:30.000Z",
      thread: makeReadModelThread({
        id: threadId,
        updatedAt: "2026-02-27T00:06:30.000Z",
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:06:00.000Z",
          startedAt: "2026-02-27T00:06:01.000Z",
          completedAt: "2026-02-27T00:06:04.000Z",
          assistantMessageId: messageId,
        },
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:06:04.000Z",
        },
        messages: [
          {
            id: messageId,
            role: "assistant",
            text: "Hello there",
            turnId,
            streaming: false,
            createdAt: "2026-02-27T00:06:02.000Z",
            updatedAt: "2026-02-27T00:06:04.000Z",
          },
        ],
        activities: [],
      }),
    };

    const next = syncThreadSnapshot(liveState, staleSnapshot);

    expect(next.threads[0]?.messages).toEqual([
      expect.objectContaining({
        id: messageId,
        text: "Hello there",
        streaming: false,
        completedAt: "2026-02-27T00:06:04.000Z",
      }),
    ]);
    expect(next.threads[0]?.hasLocallyActiveLatestTurn).toBe(false);
  });

  it("does not let a stale bootstrap summary clobber newer live thread state", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");
    const liveState = applyOrchestrationEvents(
      syncBootstrapReadModel(makeState(makeThread()), {
        snapshotSequence: 1,
        updatedAt: "2026-02-27T00:00:00.000Z",
        projects: makeReadModel(makeReadModelThread({})).projects,
        threads: [
          {
            id: threadId,
            projectId: ProjectId.makeUnsafe("project-1"),
            title: "Thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_INTERACTION_MODE,
            autoDeferUntil: null,
            consecutiveAutoNoops: 0,
            branch: null,
            worktreePath: null,
            latestTurn: null,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:05:00.000Z",
            archivedAt: null,
            deletedAt: null,
            session: null,
            latestUserMessageAt: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
            hasLocallyActiveLatestTurn: false,
          },
        ],
      }),
      [
        makeEvent(
          "thread.session-set",
          {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: "2026-02-27T00:07:00.000Z",
            },
          },
          { occurredAt: "2026-02-27T00:07:00.000Z" },
        ),
        makeEvent(
          "thread.message-sent",
          {
            threadId,
            messageId: MessageId.makeUnsafe("message-live"),
            role: "user",
            text: "latest prompt",
            turnId,
            streaming: false,
            createdAt: "2026-02-27T00:07:01.000Z",
            updatedAt: "2026-02-27T00:07:01.000Z",
          },
          { occurredAt: "2026-02-27T00:07:01.000Z", sequence: 2 },
        ),
      ],
    );

    const next = syncBootstrapReadModel(liveState, {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:06:00.000Z",
      projects: makeReadModel(makeReadModelThread({})).projects,
      threads: [
        {
          id: threadId,
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
          },
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          autoDeferUntil: null,
          consecutiveAutoNoops: 0,
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:06:00.000Z",
          archivedAt: null,
          deletedAt: null,
          session: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          hasLocallyActiveLatestTurn: false,
        },
      ],
    });

    expect(next.threads[0]?.updatedAt).toBe("2026-02-27T00:07:01.000Z");
    expect(next.threads[0]?.latestTurn).toMatchObject({
      turnId,
      state: "running",
    });
    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("message-live"),
    ]);
  });

  it("replaces projects using snapshot order during recovery", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState: AppState = {
      projects: [
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          location: { kind: "local" },
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          location: { kind: "local" },
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [],
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      bootstrapComplete: true,
    };
    const readModel: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
        makeReadModelProject({
          id: project3,
          title: "Project 3",
          workspaceRoot: "/tmp/project-3",
        }),
      ],
      threads: [],
    };

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects.map((project) => project.id)).toEqual([project1, project2, project3]);
  });
});

describe("incremental orchestration updates", () => {
  it("does not mark bootstrap complete for incremental events", () => {
    const state: AppState = {
      ...makeState(makeThread()),
      bootstrapComplete: false,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Updated title",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.bootstrapComplete).toBe(false);
  });

  it("updates the existing project title when project.meta-updated arrives", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const state = makeState(
      makeThread({
        projectId,
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.meta-updated", {
        projectId,
        title: "Renamed Project",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.projects[0]?.name).toBe("Renamed Project");
    expect(next.projects[0]?.updatedAt).toBe("2026-02-27T00:00:01.000Z");
  });

  it("preserves state identity for no-op project and thread deletes", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const nextAfterProjectDelete = applyOrchestrationEvent(
      state,
      makeEvent("project.deleted", {
        projectId: ProjectId.makeUnsafe("project-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );
    const nextAfterThreadDelete = applyOrchestrationEvent(
      state,
      makeEvent("thread.deleted", {
        threadId: ThreadId.makeUnsafe("thread-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(nextAfterProjectDelete).toBe(state);
    expect(nextAfterThreadDelete).toBe(state);
  });

  it("reuses an existing project row when project.created arrives with a new id for the same cwd", () => {
    const originalProjectId = ProjectId.makeUnsafe("project-1");
    const recreatedProjectId = ProjectId.makeUnsafe("project-2");
    const state: AppState = {
      projects: [
        {
          id: originalProjectId,
          name: "Project",
          cwd: "/tmp/project",
          location: { kind: "local" },
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [],
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      bootstrapComplete: true,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.created", {
        projectId: recreatedProjectId,
        title: "Project Recreated",
        workspaceRoot: "/tmp/project",
        location: { kind: "local" },
        defaultModelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        scripts: [],
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]?.id).toBe(recreatedProjectId);
    expect(next.projects[0]?.cwd).toBe("/tmp/project");
    expect(next.projects[0]?.name).toBe("Project Recreated");
  });

  it("removes stale project index entries when thread.created recreates a thread under a new project", () => {
    const originalProjectId = ProjectId.makeUnsafe("project-1");
    const recreatedProjectId = ProjectId.makeUnsafe("project-2");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const thread = makeThread({
      id: threadId,
      projectId: originalProjectId,
    });
    const state: AppState = {
      projects: [
        {
          id: originalProjectId,
          name: "Project 1",
          cwd: "/tmp/project-1",
          location: { kind: "local" },
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
        {
          id: recreatedProjectId,
          name: "Project 2",
          cwd: "/tmp/project-2",
          location: { kind: "local" },
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [thread],
      sidebarThreadsById: {},
      threadIdsByProjectId: {
        [originalProjectId]: [threadId],
      },
      bootstrapComplete: true,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId,
        projectId: recreatedProjectId,
        title: "Recovered thread",
        modelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        autoDeferUntil: null,
        consecutiveAutoNoops: 0,
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads).toHaveLength(1);
    expect(next.threads[0]?.projectId).toBe(recreatedProjectId);
    expect(next.threadIdsByProjectId[originalProjectId]).toBeUndefined();
    expect(next.threadIdsByProjectId[recreatedProjectId]).toEqual([threadId]);
  });

  it("updates only the affected thread for message events", () => {
    const thread1 = makeThread({
      id: ThreadId.makeUnsafe("thread-1"),
      messages: [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:00.000Z",
          streaming: false,
        },
      ],
    });
    const thread2 = makeThread({ id: ThreadId.makeUnsafe("thread-2") });
    const state: AppState = {
      ...makeState(thread1),
      threads: [thread1, thread2],
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: thread1.id,
        messageId: MessageId.makeUnsafe("message-1"),
        role: "assistant",
        text: " world",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads[0]?.messages[0]?.text).toBe("hello world");
    expect(next.threads[0]?.latestTurn?.state).toBe("running");
    expect(next.threads[1]).toBe(thread2);
  });

  it("applies replay batches in sequence and updates session state", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvents(state, [
      makeEvent(
        "thread.session-set",
        {
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.makeUnsafe("turn-1"),
            lastError: null,
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        },
        { sequence: 2 },
      ),
      makeEvent(
        "thread.message-sent",
        {
          threadId: thread.id,
          messageId: MessageId.makeUnsafe("assistant-1"),
          role: "assistant",
          text: "done",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: false,
          createdAt: "2026-02-27T00:00:03.000Z",
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
        { sequence: 3 },
      ),
    ]);

    expect(next.threads[0]?.session?.status).toBe("ready");
    expect(next.threads[0]?.latestTurn?.state).toBe("completed");
    expect(next.threads[0]?.messages).toHaveLength(1);
  });

  it("ignores a stale running session update when the same turn is already completed", () => {
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:01.000Z",
          completedAt: "2026-02-27T00:00:04.000Z",
          assistantMessageId: MessageId.makeUnsafe("assistant-1"),
        },
        messages: [
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "done",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:02.000Z",
            completedAt: "2026-02-27T00:00:04.000Z",
            streaming: false,
          },
        ],
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:04.000Z",
        },
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
          lastError: null,
          updatedAt: "2026-02-27T00:00:05.000Z",
        },
      }),
    );

    expect(next.threads[0]?.session?.status).toBe("ready");
    expect(next.threads[0]?.session?.activeTurnId).toBeUndefined();
    expect(next.threads[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-1"),
      state: "completed",
      completedAt: "2026-02-27T00:00:04.000Z",
    });
  });

  it("does not regress latestTurn when an older turn diff completes late", () => {
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-2"),
          state: "running",
          requestedAt: "2026-02-27T00:00:02.000Z",
          startedAt: "2026-02-27T00:00:03.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
        completedAt: "2026-02-27T00:00:04.000Z",
      }),
    );

    expect(next.threads[0]?.turnDiffSummaries).toHaveLength(1);
    expect(next.threads[0]?.latestTurn).toEqual(state.threads[0]?.latestTurn);
  });

  it("rebinds live turn diffs to the authoritative assistant message when it arrives later", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:02.000Z",
          assistantMessageId: MessageId.makeUnsafe("assistant:turn-1"),
        },
        turnDiffSummaries: [
          {
            turnId,
            completedAt: "2026-02-27T00:00:02.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
            assistantMessageId: MessageId.makeUnsafe("assistant:turn-1"),
            files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("assistant-real"),
        role: "assistant",
        text: "final answer",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:00:03.000Z",
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
    );

    expect(next.threads[0]?.turnDiffSummaries[0]?.assistantMessageId).toBe(
      MessageId.makeUnsafe("assistant-real"),
    );
    expect(next.threads[0]?.latestTurn?.assistantMessageId).toBe(
      MessageId.makeUnsafe("assistant-real"),
    );
  });

  it("reverts messages, plans, activities, and checkpoints by retained turns", () => {
    const state = makeState(
      makeThread({
        messages: [
          {
            id: MessageId.makeUnsafe("user-1"),
            role: "user",
            text: "first",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
            completedAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "first reply",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:01.000Z",
            completedAt: "2026-02-27T00:00:01.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("user-2"),
            role: "user",
            text: "second",
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
            completedAt: "2026-02-27T00:00:02.000Z",
            streaming: false,
          },
        ],
        proposedPlans: [
          {
            id: "plan-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "plan 1",
            implementedAt: null,
            implementationThreadId: null,
            dismissedAt: null,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: "plan-2",
            turnId: TurnId.makeUnsafe("turn-2"),
            planMarkdown: "plan 2",
            implementedAt: null,
            implementationThreadId: null,
            dismissedAt: null,
            createdAt: "2026-02-27T00:00:02.000Z",
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        activities: [
          {
            id: EventId.makeUnsafe("activity-1"),
            tone: "info",
            kind: "step",
            summary: "one",
            payload: {},
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: EventId.makeUnsafe("activity-2"),
            tone: "info",
            kind: "step",
            summary: "two",
            payload: {},
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        turnDiffSummaries: [
          {
            turnId: TurnId.makeUnsafe("turn-1"),
            completedAt: "2026-02-27T00:00:01.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("ref-1"),
            files: [],
          },
          {
            turnId: TurnId.makeUnsafe("turn-2"),
            completedAt: "2026-02-27T00:00:03.000Z",
            status: "ready",
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.makeUnsafe("ref-2"),
            files: [],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.reverted", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
      }),
    );

    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
    expect(next.threads[0]?.proposedPlans.map((plan) => plan.id)).toEqual(["plan-1"]);
    expect(next.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.makeUnsafe("activity-1"),
    ]);
    expect(next.threads[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([
      TurnId.makeUnsafe("turn-1"),
    ]);
  });

  it("clears pending source proposed plans after revert before a new session-set event", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-2"),
        state: "completed",
        requestedAt: "2026-02-27T00:00:02.000Z",
        startedAt: "2026-02-27T00:00:02.000Z",
        completedAt: "2026-02-27T00:00:03.000Z",
        assistantMessageId: MessageId.makeUnsafe("assistant-2"),
        sourceProposedPlan: {
          threadId: ThreadId.makeUnsafe("thread-source"),
          planId: "plan-2" as never,
        },
      },
      pendingSourceProposedPlan: {
        threadId: ThreadId.makeUnsafe("thread-source"),
        planId: "plan-2" as never,
      },
      turnDiffSummaries: [
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          completedAt: "2026-02-27T00:00:01.000Z",
          status: "ready",
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe("ref-1"),
          files: [],
        },
        {
          turnId: TurnId.makeUnsafe("turn-2"),
          completedAt: "2026-02-27T00:00:03.000Z",
          status: "ready",
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.makeUnsafe("ref-2"),
          files: [],
        },
      ],
    });
    const reverted = applyOrchestrationEvent(
      makeState(thread),
      makeEvent("thread.reverted", {
        threadId: thread.id,
        turnCount: 1,
      }),
    );

    expect(reverted.threads[0]?.pendingSourceProposedPlan).toBeUndefined();

    const next = applyOrchestrationEvent(
      reverted,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-3"),
          lastError: null,
          updatedAt: "2026-02-27T00:00:04.000Z",
        },
      }),
    );

    expect(next.threads[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-3"),
      state: "running",
    });
    expect(next.threads[0]?.latestTurn?.sourceProposedPlan).toBeUndefined();
  });
});
