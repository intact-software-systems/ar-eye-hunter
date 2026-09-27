/**
 * Which store pair of a runtime a lane runs over: the IndexedDB pair (`durable`) or the session's memory
 * pair (`volatile`). A lane names it on every diagnostic it states, so a reader of storage timings can keep
 * the two apart; the WS server's single-lane runtime is always `durable`.
 */
export type ALStoreDurability = 'volatile' | 'durable';
