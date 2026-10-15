import type { PersistedPromptTiming } from "@posthog/core/sessions/sessionService";
import { electronStorage } from "@posthog/ui/shell/rendererStorage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SessionTimingState {
  timingsByRunId: Record<string, PersistedPromptTiming>;
  hasHydrated: boolean;
  setHasHydrated: (hydrated: boolean) => void;
  setTiming: (taskRunId: string, timing: PersistedPromptTiming) => void;
  getTiming: (taskRunId: string) => PersistedPromptTiming | undefined;
  removeTiming: (taskRunId: string) => void;
}

const useSessionTimingStore = create<SessionTimingState>()(
  persist(
    (set, get) => ({
      timingsByRunId: {},
      hasHydrated: false,
      setHasHydrated: (hydrated) => set({ hasHydrated: hydrated }),
      setTiming: (taskRunId, timing) =>
        set((state) => ({
          timingsByRunId: { ...state.timingsByRunId, [taskRunId]: timing },
        })),
      getTiming: (taskRunId) => get().timingsByRunId[taskRunId],
      removeTiming: (taskRunId) =>
        set((state) => {
          const { [taskRunId]: _removed, ...rest } = state.timingsByRunId;
          return { timingsByRunId: rest };
        }),
    }),
    {
      name: "session-timing-storage",
      storage: electronStorage,
      partialize: (state) => ({ timingsByRunId: state.timingsByRunId }),
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          useSessionTimingStore.getState().setHasHydrated(true);
        } else {
          state?.setHasHydrated(true);
        }
      },
    },
  ),
);

export function getPersistedPromptTiming(
  taskRunId: string,
): PersistedPromptTiming | undefined {
  return useSessionTimingStore.getState().getTiming(taskRunId);
}

export function setPersistedPromptTiming(
  taskRunId: string,
  timing: PersistedPromptTiming,
): void {
  useSessionTimingStore.getState().setTiming(taskRunId, timing);
}

export function removePersistedPromptTiming(taskRunId: string): void {
  useSessionTimingStore.getState().removeTiming(taskRunId);
}

export function waitForPersistedPromptTiming(): Promise<void> {
  if (useSessionTimingStore.getState().hasHydrated) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const unsubscribe = useSessionTimingStore.subscribe((state) => {
      if (state.hasHydrated) {
        unsubscribe();
        resolve();
      }
    });
  });
}
