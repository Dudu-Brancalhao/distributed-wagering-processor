import { describe, expect, test } from "bun:test";
import type { AppLogger } from "../../../src/application/ports/app-logger.port";
import type { ReceivedMessage, SqsQueueGateway } from "../../../src/infrastructure/sqs/sqs-queue-gateway";
import { MessageBatch } from "../../../src/interfaces/sqs/message-batch";

const VISIBILITY_TIMEOUT_S = 30;

const silentLogger: AppLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Records visibility changes; the only gateway call the batch itself makes. */
class RecordingGateway {
  readonly visibilityChanges: Array<{ id: string; seconds: number }> = [];

  async changeVisibility(message: ReceivedMessage, seconds: number): Promise<void> {
    this.visibilityChanges.push({ id: message.sqsMessageId, seconds });
  }
}

function message(id: string, groupId: string, receivedAt = performance.now()): ReceivedMessage {
  return { sqsMessageId: id, body: "{}", receiptHandle: `receipt-${id}`, groupId, receiveCount: 1, receivedAt };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function batchOf(
  messages: ReceivedMessage[],
  handle: (message: ReceivedMessage) => Promise<void>,
  { concurrency = 10, stop = new AbortController() } = {},
) {
  const gateway = new RecordingGateway();
  const batch = new MessageBatch(messages, {
    handle,
    gateway: gateway as unknown as SqsQueueGateway,
    logger: silentLogger,
    concurrency,
    visibilityTimeoutS: VISIBILITY_TIMEOUT_S,
    stopSignal: stop.signal,
  });
  return { batch, gateway, stop };
}

describe("MessageBatch (spec 3.14)", () => {
  test("messages of one group run in batch order; groups run in parallel", async () => {
    const events: string[] = [];
    const releaseA1 = deferred();
    const { batch } = batchOf(
      [message("a1", "A"), message("b1", "B"), message("a2", "A")],
      async ({ sqsMessageId }) => {
        events.push(`start ${sqsMessageId}`);
        if (sqsMessageId === "a1") await releaseA1.promise;
        events.push(`end ${sqsMessageId}`);
      },
    );
    const run = batch.run();
    await Bun.sleep(0);
    expect(events).toEqual(["start a1", "start b1", "end b1"]);
    releaseA1.resolve();
    await run;
    expect(events.slice(3)).toEqual(["end a1", "start a2", "end a2"]);
  });

  test("a failing message does not stop the rest of its group", async () => {
    const handled: string[] = [];
    const { batch } = batchOf([message("a1", "A"), message("a2", "A")], async ({ sqsMessageId }) => {
      handled.push(sqsMessageId);
      if (sqsMessageId === "a1") throw new Error("settlement failed");
    });
    await batch.run();
    expect(handled).toEqual(["a1", "a2"]);
  });

  test("groups beyond the concurrency limit wait for a free slot", async () => {
    let running = 0;
    let maxRunning = 0;
    const { batch } = batchOf(
      ["A", "B", "C", "D"].map((group) => message(group, group)),
      async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await Bun.sleep(1);
        running -= 1;
      },
      { concurrency: 2 },
    );
    await batch.run();
    expect(maxRunning).toBe(2);
  });

  test("on stop, messages not started yet are made visible at once and never handled", async () => {
    const inFlight = deferred();
    const handled: string[] = [];
    const { batch, gateway, stop } = batchOf(
      [message("a1", "A"), message("a2", "A"), message("b1", "B")],
      async ({ sqsMessageId }) => {
        handled.push(sqsMessageId);
        await inFlight.promise;
      },
      { concurrency: 1 },
    );
    const run = batch.run();
    await Bun.sleep(0);
    stop.abort();
    expect(gateway.visibilityChanges).toEqual([
      { id: "a2", seconds: 0 },
      { id: "b1", seconds: 0 },
    ]);
    inFlight.resolve();
    await run;
    expect(handled).toEqual(["a1"]);
  });

  test("releaseInFlight makes the running messages visible at once", async () => {
    const inFlight = deferred();
    const { batch, gateway } = batchOf([message("a1", "A")], () => inFlight.promise);
    const run = batch.run();
    await Bun.sleep(0);
    await batch.releaseInFlight();
    expect(gateway.visibilityChanges).toEqual([{ id: "a1", seconds: 0 }]);
    inFlight.resolve();
    await run;
  });

  test("a message that waited past half its visibility timeout gets the full timeout before it starts", async () => {
    const longAgo = performance.now() - (VISIBILITY_TIMEOUT_S / 2) * 1000 - 1;
    const { batch, gateway } = batchOf([message("old", "A", longAgo), message("fresh", "B")], async () => {});
    await batch.run();
    expect(gateway.visibilityChanges).toEqual([{ id: "old", seconds: VISIBILITY_TIMEOUT_S }]);
  });
});
