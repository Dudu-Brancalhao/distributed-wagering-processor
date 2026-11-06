import { describe, expect, test } from "bun:test";
import { PollingLoop } from "../../../src/interfaces/workers/polling-loop";

const LONG_INTERVAL_MS = 60_000;

/** Lets every pending promise continuation run, so the loop has entered its pause. */
const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("PollingLoop", () => {
  test("runs again at once while the tick reports more work, then pauses", async () => {
    let ticks = 0;
    let paused!: () => void;
    const pausedNow = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const loop = new PollingLoop(async () => {
      ticks += 1;
      if (ticks === 3) paused();
      return ticks < 3;
    }, LONG_INTERVAL_MS);

    loop.start();
    await pausedNow;
    await loop.stop();
    expect(ticks).toBe(3);
  });

  test("stop interrupts the pause instead of waiting for the interval", async () => {
    let ticks = 0;
    const loop = new PollingLoop(async () => {
      ticks += 1;
      return false;
    }, LONG_INTERVAL_MS);
    loop.start();
    await nextMacrotask();
    expect(ticks).toBe(1);
    const startedAt = performance.now();
    await loop.stop();
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(ticks).toBe(1);
  });

  test("stop lets the current tick finish", async () => {
    let finish!: () => void;
    let finished = false;
    const loop = new PollingLoop(
      () =>
        new Promise<boolean>((resolve) => {
          finish = () => {
            finished = true;
            resolve(true);
          };
        }),
      LONG_INTERVAL_MS,
    );
    loop.start();
    const stopped = loop.stop();
    finish();
    await stopped;
    expect(finished).toBe(true);
  });
});
