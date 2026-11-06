export interface UnitOfWork {
  /** Runs `work` in one SQL transaction and commits when it resolves; joins the transaction already open, if any. */
  run<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Runs `work` in a fresh persistence context (empty identity map). Used by the owner of the outermost unit of work,
   * for example to retry it after an aborted attempt; inside an already open transaction it still joins that one.
   */
  isolated<T>(work: () => Promise<T>): Promise<T>;
}
