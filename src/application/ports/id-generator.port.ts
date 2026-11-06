/** Generates time-ordered unique identifiers (UUIDv7). */
export interface IdGenerator {
  next(): string;
}
