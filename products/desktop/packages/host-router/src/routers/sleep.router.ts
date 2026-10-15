import { SLEEP_SERVICE } from "@posthog/core/sleep/identifiers";
import type { SleepService } from "@posthog/core/sleep/sleep";
import { publicProcedure, router } from "@posthog/host-trpc/trpc";
import {
  type IPowerManager,
  POWER_MANAGER_SERVICE,
} from "@posthog/platform/power-manager";
import { z } from "zod";

export const sleepRouter = router({
  getEnabled: publicProcedure
    .output(z.boolean())
    .query(({ ctx }) =>
      ctx.container.get<SleepService>(SLEEP_SERVICE).getEnabled(),
    ),

  setEnabled: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => {
      ctx.container.get<SleepService>(SLEEP_SERVICE).setEnabled(input.enabled);
    }),

  hasBuiltInBattery: publicProcedure
    .output(z.boolean())
    .query(({ ctx }) =>
      ctx.container.get<SleepService>(SLEEP_SERVICE).hasBuiltInBattery(),
    ),

  onSuspendCycle: publicProcedure.subscription(async function* (opts) {
    const powerManager = opts.ctx.container.get<IPowerManager>(
      POWER_MANAGER_SERVICE,
    );
    const queue: Array<{ startedAt: number; endedAt: number }> = [];
    let suspendedAt: number | null = null;
    let resolve: (() => void) | null = null;
    const unsubscribeSuspend = powerManager.onSuspend(() => {
      suspendedAt ??= Date.now();
    });
    const unsubscribeResume = powerManager.onResume(() => {
      if (suspendedAt === null) return;
      queue.push({ startedAt: suspendedAt, endedAt: Date.now() });
      suspendedAt = null;
      resolve?.();
    });
    try {
      while (!opts.signal?.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((next) => {
            const finish = () => {
              opts.signal?.removeEventListener("abort", finish);
              next();
            };
            resolve = finish;
            opts.signal?.addEventListener("abort", finish, { once: true });
          });
          resolve = null;
        }
        while (queue.length > 0) {
          yield queue.shift() as { startedAt: number; endedAt: number };
        }
      }
    } finally {
      unsubscribeSuspend();
      unsubscribeResume();
    }
  }),
});
