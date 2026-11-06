const DEFAULT_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 10;

/** Polls `assertion` until it passes or `timeoutMs` elapses, then rethrows its last failure (spec 3.21). */
export async function eventually<T>(
  assertion: () => Promise<T> | T,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      return await assertion();
    } catch (error) {
      if (performance.now() >= deadline) throw error;
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }
}
