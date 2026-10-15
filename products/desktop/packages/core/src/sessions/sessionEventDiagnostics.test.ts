import type { AgentSession } from "@posthog/shared";
import { describe, expect, it, vi } from "vitest";
import { SessionService, type SessionServiceDeps } from "./sessionService";

const RUN_ID = "run-1";

interface Handlers {
  onData: (payload: unknown) => void;
  onError?: (err: unknown) => void;
}

function fakeSubscription() {
  const subscriptions: { handlers: Handlers; unsubscribe: () => void }[] = [];
  return {
    subscriptions,
    subscribe: vi.fn((_input: unknown, handlers: Handlers) => {
      const unsubscribe = vi.fn();
      subscriptions.push({ handlers, unsubscribe });
      return { unsubscribe };
    }),
  };
}

function createHarness(sessionOverrides: Partial<AgentSession> = {}) {
  const sessions: Record<string, AgentSession> = {
    [RUN_ID]: {
      taskRunId: RUN_ID,
      taskId: "task-1",
      taskTitle: "Local Task",
      events: [],
      messageQueue: [],
      pendingPermissions: new Map(),
      status: "connected",
      isPromptPending: false,
      promptStartedAt: null,
      ...sessionOverrides,
    } as unknown as AgentSession,
  };
  const events = fakeSubscription();
  const permissions = fakeSubscription();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const deps = {
    store: {
      getSessions: () => sessions,
      getSessionByTaskId: (taskId: string) =>
        Object.values(sessions).find((s) => s.taskId === taskId),
      updateSession: vi.fn(),
      appendEvents: vi.fn(),
      replaceOptimisticWithEvent: vi.fn(),
      setPendingPermissions: vi.fn(),
      clearMessageQueue: vi.fn(),
      clearTailOptimisticItems: vi.fn(),
      appendOptimisticItem: vi.fn(),
    },
    log,
    getIsOnline: () => true,
    notifyAgentSession: vi.fn(),
    enqueueSpeech: vi.fn(),
    trpc: {
      agent: {
        onSessionEvent: { subscribe: events.subscribe },
        onPermissionRequest: { subscribe: permissions.subscribe },
        onSessionIdleKilled: { subscribe: () => ({ unsubscribe: vi.fn() }) },
      },
    },
  } as unknown as SessionServiceDeps;
  const service = new SessionService(deps);
  (
    service as unknown as { subscribeToChannel(taskRunId: string): void }
  ).subscribeToChannel(RUN_ID);
  return { service, events, permissions, log, deps };
}

describe("session event diagnostics", () => {
  it("keeps applying a batch after one event throws, and logs the failure", () => {
    vi.useFakeTimers();
    try {
      const { events, log, deps } = createHarness();
      const chunk = (text: string) => ({
        type: "acp_message",
        ts: 1,
        message: {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: RUN_ID,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          },
        },
      });
      const appendEvents = deps.store.appendEvents as ReturnType<typeof vi.fn>;
      appendEvents.mockImplementationOnce(() => {
        throw new Error("boom");
      });

      events.subscriptions[0].handlers.onData(chunk("first"));
      events.subscriptions[0].handlers.onData(chunk("second"));
      vi.advanceTimersByTime(20);

      expect(appendEvents).toHaveBeenCalledTimes(2);
      expect(log.error).toHaveBeenCalledWith(
        "Session event handling failed",
        expect.objectContaining({
          taskRunId: RUN_ID,
          method: "session/update:agent_message_chunk",
          failed: 1,
          received: 2,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  describe("silence while a local prompt is pending", () => {
    const chunk = {
      type: "acp_message",
      ts: 1,
      message: {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: RUN_ID,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "x" },
          },
        },
      },
    };
    const completion = {
      type: "acp_message",
      ts: 2,
      message: {
        jsonrpc: "2.0",
        id: 1,
        result: { stopReason: "end_turn" },
      },
    };

    it.each([
      {
        name: "logs one warning after a minute of silence",
        eventEvery: null,
        warnings: 1,
      },
      {
        name: "stays quiet while events keep arriving",
        eventEvery: 30_000,
        warnings: 0,
      },
    ])("$name", ({ eventEvery, warnings }) => {
      vi.useFakeTimers();
      try {
        const { events, log, service } = createHarness({
          isPromptPending: true,
          promptStartedAt: Date.now(),
        });
        // A first event starts the check, as the prompt echo does in the app.
        events.subscriptions[0].handlers.onData(chunk);

        for (let elapsed = 0; elapsed < 150_000; elapsed += 30_000) {
          vi.advanceTimersByTime(30_000);
          if (eventEvery !== null) {
            events.subscriptions[0].handlers.onData(chunk);
          }
        }

        const silenceWarnings = log.warn.mock.calls.filter(
          ([message]) =>
            message === "Local session silent while a prompt is pending",
        );
        expect(silenceWarnings).toHaveLength(warnings);
        if (warnings > 0) {
          expect(silenceWarnings[0][1]).toMatchObject({
            taskRunId: RUN_ID,
            subscribed: true,
            online: true,
          });
        }
        service.reset();
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      {
        name: "records a long clock jump before the completion event is applied",
        clockJumpMs: 2 * 60 * 60_000,
        expectedPausedMs: 2 * 60 * 60_000 - 30_000,
      },
      {
        name: "ignores normal timer throttling",
        clockJumpMs: 60_000,
        expectedPausedMs: null,
      },
    ])("$name", ({ clockJumpMs, expectedPausedMs }) => {
      vi.useFakeTimers();
      try {
        const { events, deps, service } = createHarness({
          isPromptPending: true,
          promptStartedAt: Date.now(),
          pausedDurationMs: 0,
          currentPromptId: 1,
        });
        events.subscriptions[0].handlers.onData(chunk);
        const updateSession = deps.store.updateSession as ReturnType<
          typeof vi.fn
        >;
        updateSession.mockClear();

        vi.setSystemTime(Date.now() + clockJumpMs);
        events.subscriptions[0].handlers.onData(completion);
        vi.advanceTimersByTime(20);

        const pauseUpdates = updateSession.mock.calls.filter(
          ([, patch]) => "pausedDurationMs" in patch,
        );
        expect(pauseUpdates).toEqual(
          expectedPausedMs === null
            ? []
            : [[RUN_ID, { pausedDurationMs: expectedPausedMs }]],
        );
        expect(updateSession).toHaveBeenCalledWith(RUN_ID, {
          isPromptPending: false,
          promptStartedAt: null,
          currentPromptId: null,
        });
        if (expectedPausedMs !== null) {
          expect(updateSession.mock.calls[0]).toEqual([
            RUN_ID,
            { pausedDurationMs: expectedPausedMs },
          ]);
        }
        service.reset();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
