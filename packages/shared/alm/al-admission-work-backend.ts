import type { QueueBoxCompletedRetention } from '../queuebox/queue-box-completed-retention.ts';
import type { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import type { Key, ResourceEntry } from '../queuebox/ResourceEntry.ts';
import type {
    ALAdmissionBackend,
    ALAdmissionReadContext,
    ALAdmissionWriteContext
} from './al-admission-backend.ts';

/** All session namespaces share these retained fact/action topics in one admission queue. */
export const AL_ADMISSION_WORK_COMPLETED_RETENTION: QueueBoxCompletedRetention = {
    typeIds: ['WS_OUTBOX'],
    topicIds: ['AL_OUTBOUND_MESSAGE', 'AL_OUTBOUND_IDENTITY', 'AL_OUTBOUND']
};

/**
 * The read half of an admission transaction: state rows and work slots from one store snapshot.
 * A decision surface runs the same chain against a read session or inside an open write.
 */
export interface ALAdmissionReadSession extends ALAdmissionReadContext {
    readWork(key: Key): Promise<ResourceEntry | undefined>;
}

export interface ALAdmissionWorkWriteContext extends ALAdmissionWriteContext, ALAdmissionReadSession {
    /**
     * Captures the slot of a row this caller claimed, as its claim returned it. A backend may answer
     * from the claim instead of reading the row; it then fences the commit on every column of exactly
     * that value, inside the commit, whether or not the commit also writes the row.
     */
    readClaimedWork(claimed: ResourceEntry): Promise<ResourceEntry | undefined>;
    /** Records a computed entry against the exact slot already captured by readWork or readClaimedWork. */
    writeWork(entry: ResourceEntry): void;
    /**
     * Sets the row that fences the whole commit, as `set` does. A backend that writes the commit's rows in one
     * statement writes this one first and every other row only on it, so a fence that moved writes nothing. A
     * commit names at most one fence, and every commit that writes a row another commit fences on names that row
     * as its fence too, so each of them locks it first. A commit that names no fence is fenced on its first row in
     * key order.
     */
    setFence<V>(key: string, value: V, expireAtTimestamp?: number): Promise<void>;
}

export interface ALAdmissionWorkBackend extends ALAdmissionBackend {
    readonly workQueue: QueueBoxResourceEntryRepository;
    /**
     * Serves one decision surface's whole read chain from a single store snapshot. The session
     * never writes, so a caller keeps its reads outside the write transaction that follows them.
     */
    readWithin<T>(read: (session: ALAdmissionReadSession) => Promise<T>): Promise<T>;
    /** Records the supplied state and queue entries in one conditional commit. */
    write<T>(
        operation: (context: ALAdmissionWorkWriteContext) => Promise<T>,
        executionExpiresAtMs?: number | null
    ): Promise<T>;
}

/** A commit names at most one fence; naming the same row again is the same fence. */
export function assertALAdmissionFence(named: string | undefined, key: string): void {
    if (named !== undefined && named !== key) {
        throw new TypeError('An admission commit is fenced on one row');
    }
}
