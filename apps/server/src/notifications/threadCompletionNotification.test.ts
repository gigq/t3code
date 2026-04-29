import { describe, expect, it } from "vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import {
  buildThreadCompletionNotification,
  isThreadCompletionNotificationEvent,
} from "./threadCompletionNotification";

function makeSnapshot(options?: {
  assistantText?: string;
  assistantMessageId?: MessageId | null;
}): OrchestrationReadModel {
  const assistantMessageId = options?.assistantMessageId ?? MessageId.makeUnsafe("assistant-1");
  return {
    snapshotSequence: 1,
    updatedAt: "2026-03-30T00:00:02.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Polymaker",
        workspaceRoot: "/tmp/polymaker",
        location: { kind: "local" },
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-03-30T00:00:00.000Z",
        updatedAt: "2026-03-30T00:00:00.000Z",
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Fix notification payload",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        autoDeferUntil: null,
        consecutiveAutoNoops: 0,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-03-30T00:00:00.000Z",
        updatedAt: "2026-03-30T00:00:00.000Z",
        archivedAt: null,
        deletedAt: null,
        messages:
          assistantMessageId === null
            ? []
            : [
                {
                  id: assistantMessageId,
                  role: "assistant",
                  text: options?.assistantText ?? "Done with the task.",
                  attachments: [],
                  turnId: TurnId.makeUnsafe("turn-1"),
                  streaming: false,
                  createdAt: "2026-03-30T00:00:00.000Z",
                  updatedAt: "2026-03-30T00:00:01.000Z",
                },
              ],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
  };
}

function makeEvent(
  payload?: Partial<Extract<OrchestrationEvent, { type: "thread.turn-completed" }>["payload"]>,
): Extract<OrchestrationEvent, { type: "thread.turn-completed" }> {
  return {
    sequence: 1,
    eventId: EventId.makeUnsafe("event-1"),
    aggregateKind: "thread",
    aggregateId: ThreadId.makeUnsafe("thread-1"),
    occurredAt: "2026-03-30T00:00:01.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.turn-completed",
    payload: {
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: TurnId.makeUnsafe("turn-1"),
      state: "completed",
      assistantMessageId: MessageId.makeUnsafe("assistant-1"),
      completedAt: "2026-03-30T00:00:01.000Z",
      ...payload,
    },
  };
}

describe("thread completion notifications", () => {
  it("matches only completed turn events", () => {
    expect(isThreadCompletionNotificationEvent(makeEvent())).toBe(true);
    expect(
      isThreadCompletionNotificationEvent({
        ...makeEvent(),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: MessageId.makeUnsafe("assistant-1"),
          role: "assistant",
          text: "Done with the task.",
          attachments: [],
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: false,
          createdAt: "2026-03-30T00:00:00.000Z",
          updatedAt: "2026-03-30T00:00:01.000Z",
        },
      } as OrchestrationEvent),
    ).toBe(false);
  });

  it("builds a notification for completed turns", () => {
    expect(buildThreadCompletionNotification(makeEvent(), makeSnapshot())).toEqual({
      threadId: "thread-1",
      title: "Polymaker - Fix notification payload",
      body: "Done with the task.",
      tag: "thread-completed:turn-1",
      urlPath: "/thread-1",
    });
  });

  it("falls back to a generic body when the assistant text is blank", () => {
    expect(
      buildThreadCompletionNotification(makeEvent(), makeSnapshot({ assistantText: "   " })),
    ).toEqual(
      expect.objectContaining({
        body: "Assistant finished responding.",
      }),
    );
  });

  it("falls back to a generic body when no assistant message id was captured", () => {
    const baseSnapshot = makeSnapshot({ assistantMessageId: null });
    const thread = baseSnapshot.threads[0]!;
    const snapshot = {
      ...baseSnapshot,
      threads: [Object.assign({}, thread, { messages: [] })],
    } satisfies OrchestrationReadModel;
    expect(
      buildThreadCompletionNotification(makeEvent({ assistantMessageId: null }), snapshot),
    ).toEqual(
      expect.objectContaining({
        body: "Assistant finished responding.",
      }),
    );
  });

  it("falls back to the latest assistant message on the completed turn when the message id is missing", () => {
    const baseSnapshot = makeSnapshot({ assistantMessageId: null });
    const thread = baseSnapshot.threads[0]!;
    const snapshot = {
      ...baseSnapshot,
      threads: [
        Object.assign({}, thread, {
          messages: [
            {
              id: MessageId.makeUnsafe("assistant-old"),
              role: "assistant" as const,
              text: "Older assistant turn text.",
              attachments: [],
              turnId: TurnId.makeUnsafe("turn-1"),
              streaming: false,
              createdAt: "2026-03-30T00:00:00.000Z",
              updatedAt: "2026-03-30T00:00:01.000Z",
            },
            {
              id: MessageId.makeUnsafe("assistant-new"),
              role: "assistant" as const,
              text: "Final assistant text for the turn.",
              attachments: [],
              turnId: TurnId.makeUnsafe("turn-1"),
              streaming: false,
              createdAt: "2026-03-30T00:00:02.000Z",
              updatedAt: "2026-03-30T00:00:03.000Z",
            },
            {
              id: MessageId.makeUnsafe("assistant-other-turn"),
              role: "assistant" as const,
              text: "Wrong turn text.",
              attachments: [],
              turnId: TurnId.makeUnsafe("turn-2"),
              streaming: false,
              createdAt: "2026-03-30T00:00:04.000Z",
              updatedAt: "2026-03-30T00:00:05.000Z",
            },
          ],
        }),
      ],
    } satisfies OrchestrationReadModel;

    expect(
      buildThreadCompletionNotification(makeEvent({ assistantMessageId: null }), snapshot),
    ).toEqual(
      expect.objectContaining({
        body: "Final assistant text for the turn.",
      }),
    );
  });

  it("truncates very long bodies", () => {
    const notification = buildThreadCompletionNotification(
      makeEvent(),
      makeSnapshot({ assistantText: "x".repeat(400) }),
    );
    expect(notification?.body.length).toBeLessThanOrEqual(160);
    expect(notification?.body.endsWith("…")).toBe(true);
  });

  it("falls back cleanly when the thread is missing from the snapshot", () => {
    expect(
      buildThreadCompletionNotification(makeEvent(), {
        ...makeSnapshot(),
        threads: [],
        projects: [],
      }),
    ).toEqual({
      threadId: "thread-1",
      title: "Thread completed",
      body: "Assistant finished responding.",
      tag: "thread-completed:turn-1",
      urlPath: "/thread-1",
    });
  });
});
