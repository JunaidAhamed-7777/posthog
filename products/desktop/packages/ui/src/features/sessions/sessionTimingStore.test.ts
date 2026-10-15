import { describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => {
  let resolveHydration!: (value: null) => void;
  return {
    hydration: new Promise<null>((resolve) => {
      resolveHydration = resolve;
    }),
    resolveHydration,
  };
});

vi.mock("@posthog/ui/shell/rendererStorage", () => ({
  electronStorage: {
    getItem: vi.fn(() => storage.hydration),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

import { waitForPersistedPromptTiming } from "./sessionTimingStore";

describe("sessionTimingStore", () => {
  it("waits until persisted prompt timing has hydrated", async () => {
    let resolved = false;
    const waiting = waitForPersistedPromptTiming().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    storage.resolveHydration(null);

    await expect(waiting).resolves.toBeUndefined();
    expect(resolved).toBe(true);
  });
});
