import type { ALAdmissionBackendEntry } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionDecoder } from '@shared/alm/al-admission-decoder.ts';
import type { ALAdmissionWorkBackend, ALAdmissionWorkWriteContext } from '@shared/alm/al-admission-work-backend.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import { toResourceEntrySnapshot } from '@shared/queuebox/in-memory-queue-box.ts';
import { toKeyAsString, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '../../queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '../../queuebox/postgres/p-sql-queue-box.ts';
import { PSqlResourceInboxEntryRepository } from '../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import {
    createTransactionBoundPSqlRuntimeStateRepository,
    PSqlRuntimeStateRepository
} from '../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { PSqlAdmissionMutationCollector } from './p-sql-admission-mutation-collector.ts';

export class PSqlAdmissionWorkBackend implements ALAdmissionWorkBackend {
    readonly workQueue: PSqlQueueBox;
    private readonly sql: PSqlSql;
    private readonly repository: PSqlRuntimeStateRepository;
    private readonly namespace: string;

    constructor(
        sql: PSqlSql,
        namespace: string
    ) {
        this.sql = sql;
        this.repository = new PSqlRuntimeStateRepository(sql);
        this.workQueue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql));
        this.namespace = namespace;
    }

    async ready(): Promise<void> {}

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        return await new PSqlAdmissionMutationCollector(
            this.repository,
            this.namespace,
            Date.now
        ).read(key, decode);
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        return await new PSqlAdmissionMutationCollector(
            this.repository,
            this.namespace,
            Date.now
        ).list(prefix, decode);
    }

    async write<T>(fn: (tx: ALAdmissionWorkWriteContext) => Promise<T>): Promise<T> {
        const collector = new PSqlAdmissionWorkWriteBuffer(this.repository, this.namespace, this.workQueue);
        const result = await fn(collector);
        const mutations = collector.mutations();
        const workWrites = collector.workWrites();
        if (mutations.length === 0 && workWrites.length === 0) {
            return result;
        }
        try {
            await this.sql.begin(async (sql) => {
                const transaction = createTransactionBoundPSqlRuntimeStateRepository(sql);
                const work = new PSqlResourceInboxEntryRepository(sql);
                await collector.writeMutations(transaction, mutations);
                for (const write of workWrites) {
                    const committed = write.expected === undefined
                        ? await work.tryWriteIfAbsentOrReplaceExpired(write.entry)
                        : await work.replaceIfObserved(write.expected, write.entry);
                    if (committed === null) {
                        throw new ALAdmissionBackendConflictError('AL admission work write conflicted');
                    }
                }
            });
        }
        catch (error) {
            if (error instanceof RuntimeStateWriteConflictError) {
                throw new ALAdmissionBackendConflictError(
                    'AL admission apply conflict',
                    { cause: error }
                );
            }
            throw error;
        }
        return result;
    }
}

interface PSqlAdmissionWorkWrite {
    readonly expected: ResourceEntry | undefined;
    readonly entry: ResourceEntry;
}

class PSqlAdmissionWorkWriteBuffer extends PSqlAdmissionMutationCollector implements ALAdmissionWorkWriteContext {
    private readonly workQueue: PSqlQueueBox;
    private readonly workObservations = new Map<string, ResourceEntry | undefined>();
    private readonly pendingWork = new Map<string, ResourceEntry>();

    constructor(repository: PSqlRuntimeStateRepository, namespace: string, workQueue: PSqlQueueBox) {
        super(repository, namespace, Date.now);
        this.workQueue = workQueue;
    }

    async readWork(key: Key): Promise<ResourceEntry | undefined> {
        const keyString = toKeyAsString(key);
        const pending = this.pendingWork.get(keyString);
        if (pending !== undefined) {
            return toResourceEntrySnapshot(pending);
        }
        if (!this.workObservations.has(keyString)) {
            this.workObservations.set(keyString, await this.workQueue.getItem(key));
        }
        const observed = this.workObservations.get(keyString);
        return observed === undefined ? undefined : toResourceEntrySnapshot(observed);
    }

    writeWork(entry: ResourceEntry): void {
        const key = toKeyAsString(entry.key);
        if (!this.workObservations.has(key) || this.pendingWork.has(key)) {
            throw new TypeError('Admission work requires one write after its slot has been read');
        }
        this.pendingWork.set(key, toResourceEntrySnapshot(entry));
    }

    workWrites(): readonly PSqlAdmissionWorkWrite[] {
        return [...this.pendingWork].map(([key, entry]) => ({ entry, expected: this.workObservations.get(key) }));
    }
}
