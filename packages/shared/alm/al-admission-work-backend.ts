import type { QueueBoxCompletedRetention } from '../queuebox/queue-box-completed-retention.ts';
import type { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import type { Key, ResourceEntry } from '../queuebox/ResourceEntry.ts';
import type { ALAdmissionBackend, ALAdmissionWriteContext } from './al-admission-backend.ts';

/** All session namespaces share these retained fact/action topics in one admission queue. */
export const AL_ADMISSION_WORK_COMPLETED_RETENTION: QueueBoxCompletedRetention = {
    typeIds: ['WS_OUTBOX'],
    topicIds: ['AL_OUTBOUND_MESSAGE', 'AL_OUTBOUND_IDENTITY', 'AL_OUTBOUND']
};

export interface ALAdmissionWorkWriteContext extends ALAdmissionWriteContext {
    readWork(key: Key): Promise<ResourceEntry | undefined>;
    /** Records a computed entry against the exact slot already captured by readWork. */
    writeWork(entry: ResourceEntry): void;
}

export interface ALAdmissionWorkBackend extends ALAdmissionBackend {
    readonly workQueue: QueueBoxResourceEntryRepository;
    /** Records the supplied state and queue entries in one conditional commit. */
    write<T>(
        operation: (context: ALAdmissionWorkWriteContext) => Promise<T>,
        executionExpiresAtMs?: number | null
    ): Promise<T>;
}
