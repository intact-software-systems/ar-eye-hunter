/**
 * Which store pair of a runtime a lane runs over: the IndexedDB pair (`durable`), the session's memory
 * pair (`volatile`), or a memory pair whose rows a checkpoint copies to IndexedDB (`checkpoint`). A lane
 * names it on every diagnostic it states, so a reader of storage timings can keep them apart; the WS
 * server's single-lane runtime is always `durable`.
 */
export type ALStoreDurability = 'volatile' | 'checkpoint' | 'durable';
