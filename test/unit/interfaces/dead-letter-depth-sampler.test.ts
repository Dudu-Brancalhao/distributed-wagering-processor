import { describe, expect, test } from "bun:test";
import { Registry } from "prom-client";
import type { AppLogger, LogFields } from "../../../src/application/ports/app-logger.port";
import { PrometheusWageringMetrics } from "../../../src/infrastructure/observability/prometheus-wagering-metrics";
import { DeadLetterDepthSampler } from "../../../src/interfaces/sqs/dead-letter-depth-sampler";

const QUEUE = "wager-transactions-dlq.fifo";
const SHORT_INTERVAL_MS = 5;

class RecordingLogger implements AppLogger {
  readonly warnings: (LogFields | undefined)[] = [];

  debug(): void {}
  info(): void {}
  error(): void {}
  warn(_message: string, fields?: LogFields): void {
    this.warnings.push(fields);
  }
}

/** A gateway answering each sample with the next depth; an `Error` entry makes that sample fail. */
function scriptedGateway(answers: (number | Error)[]) {
  let samples = 0;
  return {
    get samples() {
      return samples;
    },
    async deadLetterDepth(): Promise<number> {
      const answer = answers[Math.min(samples, answers.length - 1)];
      samples += 1;
      if (answer instanceof Error) throw answer;
      return answer ?? 0;
    },
  };
}

async function depthSeries(registry: Registry): Promise<string[]> {
  return (await registry.metrics()).split("\n").filter((line) => line.startsWith("wagering_dlq_depth{"));
}

async function runUntil(sampler: DeadLetterDepthSampler, done: () => boolean): Promise<void> {
  sampler.onApplicationBootstrap();
  while (!done()) await Bun.sleep(1);
  await sampler.beforeApplicationShutdown();
}

describe("DeadLetterDepthSampler", () => {
  test("exposes the sampled depth as wagering_dlq_depth, labeled with the queue", async () => {
    const registry = new Registry();
    const gateway = scriptedGateway([2, 3]);
    const sampler = new DeadLetterDepthSampler({
      gateway,
      queueName: QUEUE,
      metrics: new PrometheusWageringMetrics(registry, 10),
      logger: new RecordingLogger(),
      intervalMs: SHORT_INTERVAL_MS,
    });

    await runUntil(sampler, () => gateway.samples >= 2);

    expect(await depthSeries(registry)).toEqual([`wagering_dlq_depth{queue="${QUEUE}"} 3`]);
  });

  test("a failed sample is logged and keeps the last value, and sampling goes on", async () => {
    const registry = new Registry();
    const logger = new RecordingLogger();
    const gateway = scriptedGateway([4, new Error("unreachable")]);
    const sampler = new DeadLetterDepthSampler({
      gateway,
      queueName: QUEUE,
      metrics: new PrometheusWageringMetrics(registry, 10),
      logger,
      intervalMs: SHORT_INTERVAL_MS,
    });

    await runUntil(sampler, () => gateway.samples >= 3);

    expect(await depthSeries(registry)).toEqual([`wagering_dlq_depth{queue="${QUEUE}"} 4`]);
    expect(logger.warnings.length).toBeGreaterThanOrEqual(2);
    for (const fields of logger.warnings) {
      expect(fields).toEqual({ event: "sqs.dlq_depth_sampling_failed", error: "Error" });
    }
  });
});
