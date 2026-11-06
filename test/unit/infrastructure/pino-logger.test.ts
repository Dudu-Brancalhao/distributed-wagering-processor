import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { LogContext } from "../../../src/infrastructure/observability/log-context";
import { createPino, PinoAppLogger } from "../../../src/infrastructure/observability/pino-logger";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _encoding, done) {
      lines.push(
        ...String(chunk)
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
      done();
    },
  });
  const logger = new PinoAppLogger(createPino({ level: "info", instanceId: "i-1", roles: ["api"], destination }));
  return { logger, lines };
}

describe("structured logging", () => {
  test("adds the current context ids to every line", () => {
    const { logger, lines } = capture();
    LogContext.run({ correlationId: "c-1", walletId: "w-1" }, () => {
      LogContext.run({ transactionId: "t-1" }, () => logger.info("processed", { event: "transaction.processed" }));
    });
    expect(lines[0]).toMatchObject({
      msg: "processed",
      level: "info",
      event: "transaction.processed",
      correlationId: "c-1",
      walletId: "w-1",
      transactionId: "t-1",
      instanceId: "i-1",
    });
  });

  test("removes sensitive and financial fields even when passed by mistake", () => {
    const { logger, lines } = capture();
    logger.warn("oops", { event: "x", amount: "10.00", balance: "5.00", playerId: "p", idempotencyKey: "k" });
    expect(lines[0]).not.toContainKeys(["amount", "balance", "playerId", "idempotencyKey"]);
    expect(lines[0]).toMatchObject({ event: "x" });
  });
});
