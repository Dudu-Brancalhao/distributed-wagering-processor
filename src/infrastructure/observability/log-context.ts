import { AsyncLocalStorage } from "node:async_hooks";
import type { LogFields } from "../../application/ports/app-logger.port";

const storage = new AsyncLocalStorage<LogFields>();

/** Carries the identifiers of the current unit of work (request, message, worker tick) to every log line. */
export const LogContext = {
  run<T>(fields: LogFields, work: () => T): T {
    return storage.run({ ...storage.getStore(), ...fields }, work);
  },
  current(): LogFields {
    return storage.getStore() ?? {};
  },
};
