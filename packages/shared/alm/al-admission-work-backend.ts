import type { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import type { Key, ResourceEntry } from '../queuebox/ResourceEntry.ts';
import type { ALAdmissionBackend, ALAdmissionWriteContext } from './al-admission-backend.ts';

export interface ALAdmissionWorkWriteContext extends ALAdmissionWriteContext {
    readWork(key: Key): Promise<ResourceEntry | undefined>;
    /** Records a computed entry against the exact slot already captured by readWork. */
    writeWork(entry: ResourceEntry): void;
}

export interface ALAdmissionWorkBackend extends ALAdmissionBackend {
    readonly workQueue: QueueBoxResourceEntryRepository;
    /** Records the supplied state and queue entries in one conditional commit. */
    write<T>(operation: (context: ALAdmissionWorkWriteContext) => Promise<T>): Promise<T>;
}
