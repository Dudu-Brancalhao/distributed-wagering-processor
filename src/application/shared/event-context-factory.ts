import type { EventContext } from "../../domain/events/integration-event";
import type { IdGenerator } from "../ports/id-generator.port";
import type { EventOrigin } from "./execution-context";

/** Returns a factory of event contexts sharing the origin and time, each with a new event id. */
export function eventContexts(ids: IdGenerator, origin: EventOrigin, occurredAt: Date): () => EventContext {
  return () => ({
    eventId: ids.next(),
    correlationId: origin.correlationId,
    causationId: origin.causationId,
    occurredAt,
  });
}
