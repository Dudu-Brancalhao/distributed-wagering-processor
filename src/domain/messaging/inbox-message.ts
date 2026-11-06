import { InvalidMessageStateError } from "./messaging.errors";

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  readonly processedAt?: Date;
}

/** Persistent record that a consumer has handled a message, keyed by (consumerName, messageId). */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidMessageStateError(`Inbox message ${this.messageId} is already processed`);
    }
    this._processedAt = at;
  }
}
