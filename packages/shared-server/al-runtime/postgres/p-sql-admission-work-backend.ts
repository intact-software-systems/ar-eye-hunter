import { Temporal } from '@js-temporal/polyfill';
import type { ALAdmissionBackendEntry } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionDecoder } from '@shared/alm/al-admission-decoder.ts';
import type {
    ALAdmissionReadSession,
    ALAdmissionWorkBackend,
    ALAdmissionWorkWriteContext
} from '@shared/alm/al-admission-work-backend.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import { requireLivePersistenceWrite } from '@shared/persistence/persistence-write-deadline.ts';
import { toResourceEntrySnapshot } from '@shared/queuebox/resource-entry-observations.ts';
import {
    toKeyAsString,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '../../queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '../../queuebox/postgres/p-sql-queue-box.ts';
import {
    computeResourceInboxObservedReplacement,
    PSqlResourceInboxEntryRepository
} from '../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import type { ResourceInboxObservedReplacement } from '../../queuebox/postgres/replace-observed-resource-inbox-entry.ts';
import {
    computeResourceInboxEntryInsertValues,
    type ResourceInboxEntryInsertValues
} from '../../queuebox/postgres/resource-inbox-entry-insert-values.ts';
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
    private readonly nowMs: () => number;

    constructor(
        sql: PSqlSql,
        namespace: string,
        nowMs: () => number = Date.now
    ) {
        this.sql = sql;
        this.nowMs = nowMs;
        this.repository = new PSqlRuntimeStateRepository(sql);
        this.workQueue = new PSqlQueueBox(
            createPSqlResourceInboxRepository(sql),
            () => Temporal.Instant.fromEpochMilliseconds(this.nowMs())
        );
        this.namespace = namespace;
    }

    async ready(): Promise<void> {}

    /**
     * Autocommit gives each statement its own snapshot, never one across the chain, so the backend
     * is its own read session and every read is a fresh query. A chain that deliberately re-reads a
     * row -- the repair read, after it has captured the sender version that fences it -- must see
     * the row as it is now, not as some earlier statement found it. It returns the chain's own
     * promise rather than awaiting it: a session must not cost a caller an extra turn.
     */
    readWithin<T>(read: (session: ALAdmissionReadSession) => Promise<T>): Promise<T> {
        return read(this);
    }

    async readWork(key: Key): Promise<ResourceEntry | undefined> {
        return await this.workQueue.getItem(key);
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        return await new PSqlAdmissionMutationCollector(
            this.repository,
            this.namespace,
            this.nowMs
        ).read(key, decode);
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        return await new PSqlAdmissionMutationCollector(
            this.repository,
            this.namespace,
            this.nowMs
        ).list(prefix, decode);
    }

    async write<T>(
        fn: (tx: ALAdmissionWorkWriteContext) => Promise<T>,
        executionExpiresAtMs: number | null = null
    ): Promise<T> {
        const collector = new PSqlAdmissionWorkWriteBuffer({
            repository: this.repository,
            namespace: this.namespace,
            workQueue: this.workQueue,
            nowMs: this.nowMs
        });
        const result = await fn(collector);
        const mutations = collector.mutations();
        const workWrites = collector.workWrites();
        requireLivePersistenceWrite(executionExpiresAtMs, this.nowMs());
        if (mutations.length === 0 && workWrites.length === 0) {
            return result;
        }
        try {
            await this.sql.begin(async (sql) => {
                requireLivePersistenceWrite(executionExpiresAtMs, this.nowMs());
                const transaction = createTransactionBoundPSqlRuntimeStateRepository(sql);
                const work = new PSqlResourceInboxEntryRepository(sql);
                await collector.writeMutations(transaction, mutations);
                for (const write of workWrites) {
                    const committed = write.kind === 'insert'
                        ? await work.tryWriteComputedIfAbsentOrReplaceExpired(write.values)
                        : await work.writeObservedReplacement(write.computed);
                    if (committed === null) {
                        throw new ALAdmissionBackendConflictError('AL admission work write conflicted');
                    }
                }
                requireLivePersistenceWrite(executionExpiresAtMs, this.nowMs());
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

type PSqlAdmissionWorkWrite =
    | { readonly kind: 'insert'; readonly values: ResourceInboxEntryInsertValues; }
    | { readonly kind: 'replace'; readonly computed: ResourceInboxObservedReplacement; };

namespace PSqlAdmissionWorkWriteBuffer {
    export interface Input {
        readonly repository: PSqlRuntimeStateRepository;
        readonly namespace: string;
        readonly workQueue: PSqlQueueBox;
        readonly nowMs: () => number;
    }
}

class PSqlAdmissionWorkWriteBuffer extends PSqlAdmissionMutationCollector implements ALAdmissionWorkWriteContext {
    private readonly workQueue: PSqlQueueBox;
    private readonly workObservations = new Map<string, ResourceEntry | undefined>();
    private readonly pendingWork = new Map<string, ResourceEntry>();

    constructor(input: PSqlAdmissionWorkWriteBuffer.Input) {
        super(input.repository, input.namespace, input.nowMs);
        this.workQueue = input.workQueue;
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
        return [...this.pendingWork].map(([key, entry]) => {
            const expected = this.workObservations.get(key);
            return expected === undefined
                ? { kind: 'insert', values: computeResourceInboxEntryInsertValues(entry) }
                : { kind: 'replace', computed: computeResourceInboxObservedReplacement(expected, entry) };
        });
    }
}
