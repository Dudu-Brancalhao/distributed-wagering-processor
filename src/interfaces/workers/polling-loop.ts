/** Reports whether more work is already waiting, so the loop runs again at once instead of pausing. */
export type PollingTick = () => Promise<boolean>;

/**
 * Runs a tick until stopped: again at once when the tick reports more work, otherwise after `intervalMs`. `stop`
 * interrupts the pause, lets the current tick finish and resolves once the loop has exited. The tick must not reject.
 */
export class PollingLoop {
  private running?: Promise<void>;
  private stopping = false;
  private interruptPause?: () => void;

  constructor(
    private readonly tick: PollingTick,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    this.running ??= this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.interruptPause?.();
    await this.running;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      const moreWork = await this.tick();
      if (!moreWork && !this.stopping) await this.pause();
    }
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.intervalMs);
      this.interruptPause = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
