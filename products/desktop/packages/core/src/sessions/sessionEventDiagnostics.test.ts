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
  let suspendHandler:
    | ((cycle: { startedAt: number; endedAt: number }) => void)
    | undefined;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const deps = {
    store: {
      getSessions: () => sessions,
      getSessionByTaskId: (taskId: string) =>
        Object.values(sessions).find((s) => s.taskId === taskId),
      updateSession: vi.fn(
        (taskRunId: string, updates: Partial<AgentSession>) => {
          Object.assign(sessions[taskRunId], updates);
        },
      ),
      appendEvents: vi.fn(),
      replaceOptimisticWithEvent: vi.fn(),
      setPendingPermissions: vi.fn(
        (
          taskRunId: string,
          pendingPermissions: AgentSession["pendingPermissions"],
        ) => {
          sessions[taskRunId].pendingPermissions = pendingPermissions;
        },
      ),
      clearMessageQueue: vi.fn(),
      clearTailOptimisticItems: vi.fn(),
      appendOptimisticItem: vi.fn(),
    },
    log,
    subscribeToSystemSuspend: (
      handler: (cycle: { startedAt: number; endedAt: number }) => void,
    ) => {
      suspendHandler = handler;
      return vi.fn();
    },
    getIsOnline: () => true,
    notifyAgentSession: vi.fn(),
    enqueueSpeech: vi.fn(),
    taskViewedApi: { markActivity: vi.fn() },
    track: vi.fn(),
    buildPermissionToolMetadata: vi.fn(() => ({})),
    trpc: {
      agent: {
        respondToPermission: { mutate: vi.fn().mockResolvedValue(undefined) },
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
  return {
    service,
    sessions,
    events,
    permissions,
    log,
    deps,
    emitSuspend: (startedAt: number, endedAt: number) =>
      suspendHandler?.({ startedAt, endedAt }),
  };
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
    const completion = (ts: number) => ({
      type: "acp_message",
      ts,
      message: {
        jsonrpc: "2.0",
        id: 1,
        result: { stopReason: "end_turn" },
      },
    });
    const promptEcho = (ts: number, id = 1) => ({
      type: "acp_message",
      ts,
      message: {
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: { sessionId: RUN_ID, prompt: [{ type: "text", text: "go" }] },
      },
    });

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
        name: "records an explicit suspend before the completion event is applied",
        clockJumpMs: 2 * 60 * 60_000,
        suspendCycle: true,
        eventAfterJump: true,
        staleEventAfterJump: false,
        expectedPausedMs: 2 * 60 * 60_000,
      },
      {
        name: "ignores normal timer throttling",
        clockJumpMs: 60_000,
        suspendCycle: false,
        eventAfterJump: true,
        staleEventAfterJump: false,
        expectedPausedMs: null,
      },
      {
        name: "does not pause a turn that completed before suspend",
        clockJumpMs: 2 * 60 * 60_000,
        suspendCycle: true,
        eventAfterJump: false,
        staleEventAfterJump: false,
        expectedPausedMs: null,
      },
      {
        name: "does not treat a long renderer stall as suspended time",
        clockJumpMs: 2 * 60 * 60_000,
        suspendCycle: false,
        eventAfterJump: true,
        staleEventAfterJump: false,
        expectedPausedMs: null,
      },
      {
        name: "defers a suspend when a stale chunk precedes a fresh completion",
        clockJumpMs: 2 * 60 * 60_000,
        suspendCycle: true,
        eventAfterJump: true,
        staleEventAfterJump: true,
        expectedPausedMs: 2 * 60 * 60_000,
      },
      {
        name: "does not treat a Windows renderer stall as suspended time",
        clockJumpMs: 2 * 60 * 60_000,
        suspendCycle: false,
        eventAfterJump: true,
        staleEventAfterJump: false,
        expectedPausedMs: null,
      },
    ])("$name", (scenario) => {
      const { clockJumpMs, suspendCycle, eventAfterJump, expectedPausedMs } =
        scenario;
      vi.useFakeTimers();
      try {
        const beforeJump = Date.now();
        const { events, deps, service, emitSuspend } = createHarness({
          isPromptPending: true,
          promptStartedAt: beforeJump,
          pausedDurationMs: 0,
          currentPromptId: 1,
        });
        events.subscriptions[0].handlers.onData(chunk);
        const updateSession = deps.store.updateSession as ReturnType<
          typeof vi.fn
        >;
        updateSession.mockClear();

        if (!eventAfterJump) {
          events.subscriptions[0].handlers.onData(completion(beforeJump));
        }
        vi.setSystemTime(beforeJump + clockJumpMs);
        if (suspendCycle) {
          emitSuspend(beforeJump, beforeJump + clockJumpMs);
        }
        if (scenario.staleEventAfterJump) {
          events.subscriptions[0].handlers.onData({
            ...chunk,
            ts: beforeJump,
          });
        }
        if (eventAfterJump) {
          events.subscriptions[0].handlers.onData(completion(Date.now()));
        }
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

    it("flushes another run's completion before attributing suspended time", () => {
      vi.useFakeTimers();
      try {
        const beforeJump = Date.now();
        const { service, sessions, events, deps, emitSuspend } = createHarness({
          isPromptPending: true,
          promptStartedAt: beforeJump,
          pausedDurationMs: 0,
          currentPromptId: 1,
        });
        const otherRunId = "run-2";
        sessions[otherRunId] = {
          ...sessions[RUN_ID],
          taskRunId: otherRunId,
          taskId: "task-2",
        };
        (
          service as unknown as {
            subscribeToChannel(taskRunId: string): void;
          }
        ).subscribeToChannel(otherRunId);
        events.subscriptions[0].handlers.onData({ ...chunk, ts: beforeJump });
        vi.advanceTimersByTime(20);
        events.subscriptions[1].handlers.onData(completion(beforeJump));

        vi.setSystemTime(beforeJump + 2 * 60 * 60_000);
        emitSuspend(beforeJump, Date.now());
        events.subscriptions[0].handlers.onData({
          ...chunk,
          ts: Date.now(),
        });

        expect(sessions[otherRunId].isPromptPending).toBe(false);
        expect(
          (
            deps.store.updateSession as ReturnType<typeof vi.fn>
          ).mock.calls.some(
            ([taskRunId, patch]) =>
              taskRunId === otherRunId && "pausedDurationMs" in patch,
          ),
        ).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("waits for every pending run's first post-suspend event before attributing sleep", () => {
      vi.useFakeTimers();
      try {
        const beforeJump = Date.now();
        const { service, sessions, events, emitSuspend } = createHarness({
          isPromptPending: true,
          promptStartedAt: beforeJump,
          pausedDurationMs: 0,
          currentPromptId: 1,
        });
        const otherRunId = "run-2";
        sessions[otherRunId] = {
          ...sessions[RUN_ID],
          taskRunId: otherRunId,
          taskId: "task-2",
        };
        (
          service as unknown as {
            subscribeToChannel(taskRunId: string): void;
          }
        ).subscribeToChannel(otherRunId);
        events.subscriptions[0].handlers.onData({
          ...chunk,
          ts: beforeJump,
        });
        events.subscriptions[1].handlers.onData({
          ...chunk,
          ts: beforeJump,
        });
        vi.advanceTimersByTime(20);

        vi.setSystemTime(beforeJump + 2 * 60 * 60_000);
        emitSuspend(beforeJump, Date.now());
        events.subscriptions[0].handlers.onData({
          ...chunk,
          ts: Date.now(),
        });
        events.subscriptions[1].handlers.onData(completion(beforeJump));
        vi.advanceTimersByTime(20);

        expect(sessions[otherRunId].pausedDurationMs).toBe(0);
        service.reset();
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves suspended time when the live prompt echo arrives", () => {
      vi.useFakeTimers();
      try {
        const beforeJump = Date.now();
        const { service, sessions, events, emitSuspend } = createHarness({
          isPromptPending: true,
          promptStartedAt: beforeJump,
          pausedDurationMs: 0,
        });
        events.subscriptions[0].handlers.onData({ ...chunk, ts: beforeJump });
        vi.advanceTimersByTime(20);

        vi.setSystemTime(beforeJump + 2 * 60 * 60_000);
        emitSuspend(beforeJump, Date.now());
        events.subscriptions[0].handlers.onData(promptEcho(Date.now()));
        vi.advanceTimersByTime(20);

        expect(sessions[RUN_ID]).toMatchObject({
          promptStartedAt: beforeJump,
          pausedDurationMs: 2 * 60 * 60_000,
        });
        service.reset();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not attach live prompt timing to an echo from a different turn", () => {
      vi.useFakeTimers();
      try {
        const currentPromptStartedAt = Date.now();
        const { service, sessions, events } = createHarness({
          isPromptPending: true,
          promptStartedAt: currentPromptStartedAt,
          pausedDurationMs: 45_000,
          currentPromptId: 2,
        });

        events.subscriptions[0].handlers.onData(
          promptEcho(currentPromptStartedAt - 1_000, 1),
        );
        vi.advanceTimersByTime(20);

        expect(sessions[RUN_ID]).toMatchObject({
          currentPromptId: 2,
          promptStartedAt: currentPromptStartedAt,
          pausedDurationMs: 45_000,
        });
        service.reset();
      } finally {
        vi.useRealTimers();
      }
    });

    it("counts suspended and permission-wait time exactly once", async () => {
      vi.useFakeTimers();
      try {
        const beforeJump = Date.now();
        const { service, sessions, events, permissions, emitSuspend } =
          createHarness({
            isPromptPending: true,
            promptStartedAt: beforeJump,
            pausedDurationMs: 0,
            currentPromptId: 1,
          });
        events.subscriptions[0].handlers.onData({ ...chunk, ts: beforeJump });
        vi.advanceTimersByTime(20);

        vi.setSystemTime(beforeJump + 2 * 60 * 60_000);
        emitSuspend(beforeJump, Date.now());
        permissions.subscriptions[0].handlers.onData({
          taskRunId: RUN_ID,
          toolCall: { toolCallId: "tool-1", title: "Run command" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        });

        vi.setSystemTime(Date.now() + 5 * 60_000);
        await service.respondToPermission("task-1", "tool-1", "allow");
        events.subscriptions[0].handlers.onData({ ...chunk, ts: Date.now() });
        vi.advanceTimersByTime(20);

        expect(sessions[RUN_ID].pausedDurationMs).toBe(
          2 * 60 * 60_000 + 5 * 60_000,
        );
        service.reset();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps checking silence while a pending session reconnects", () => {
      vi.useFakeTimers();
      try {
        const { service, sessions, events, log } = createHarness({
          status: "connecting",
          isPromptPending: true,
          promptStartedAt: Date.now(),
        });
        events.subscriptions[0].handlers.onData({
          ...chunk,
          ts: Date.now(),
        });

        vi.advanceTimersByTime(30_000);
        sessions[RUN_ID].status = "connected";
        vi.advanceTimersByTime(60_000);

        expect(log.warn).toHaveBeenCalledWith(
          "Local session silent while a prompt is pending",
          expect.objectContaining({ taskRunId: RUN_ID }),
        );
        service.reset();
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(["disconnected", "error"] as const)(
      "stops the silence timer for a terminal local session with %s status",
      (status) => {
        vi.useFakeTimers();
        try {
          const { service, events } = createHarness({
            status,
            isPromptPending: true,
            promptStartedAt: Date.now(),
          });
          events.subscriptions[0].handlers.onData({
            ...chunk,
            ts: Date.now(),
          });
          vi.advanceTimersByTime(20);
          vi.advanceTimersByTime(30_000);
          const remainingTimerCount = vi.getTimerCount();

          expect(remainingTimerCount).toBe(0);
          service.reset();
        } finally {
          vi.useRealTimers();
        }
      },
    );
  });
});
