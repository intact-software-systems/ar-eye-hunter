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
    /** Records a computed entry against the exact slot already captured by readWork. */
    writeWork(entry: ResourceEntry): void;
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
