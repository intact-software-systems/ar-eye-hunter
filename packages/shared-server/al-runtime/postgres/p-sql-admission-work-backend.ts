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
import { TurnBatchedReads } from '@shared/resilience/turn-batched-reads.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '../../queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '../../queuebox/postgres/p-sql-queue-box.ts';
import {
    computeResourceInboxObservation,
    computeResourceInboxObservedReplacement,
    PSqlResourceInboxEntryRepository
} from '../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import type {
    ResourceInboxObservation,
    ResourceInboxObservedReplacement
} from '../../queuebox/postgres/replace-observed-resource-inbox-entry.ts';
import {
    computeResourceInboxEntryInsertValues,
    type ResourceInboxEntryInsertValues
} from '../../queuebox/postgres/resource-inbox-entry-insert-values.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import {
    createTransactionBoundPSqlRuntimeStateRepository,
    PSqlRuntimeStateRepository
} from '../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { RuntimeStateEntry } from '../../runtime-state/runtime-state-repository.ts';
import { PSqlAdmissionMutationCollector } from './p-sql-admission-mutation-collector.ts';

export class PSqlAdmissionWorkBackend implements ALAdmissionWorkBackend {
    readonly workQueue: PSqlQueueBox;
    private readonly sql: PSqlSql;
    private readonly repository: PSqlRuntimeStateRepository;
    private readonly namespace: string;
    private readonly nowMs: () => number;
    private readonly stateReads: TurnBatchedReads<string, RuntimeStateEntry | undefined>;
    private readonly workReads: TurnBatchedReads<Key, ResourceEntry | undefined>;

    constructor(
        sql: PSqlSql,
        namespace: string,
        nowMs: () => number
    ) {
        this.sql = sql;
        this.nowMs = nowMs;
        this.repository = new PSqlRuntimeStateRepository(sql);
        this.workQueue = new PSqlQueueBox(
            createPSqlResourceInboxRepository(sql, () => new Date(this.nowMs())),
            () => Temporal.Instant.fromEpochMilliseconds(this.nowMs())
        );
        this.namespace = namespace;
        this.stateReads = new TurnBatchedReads({
            toKeyId: (key) => key,
            readBatch: (keys) => readPSqlAdmissionStateEntries(this.repository, namespace, keys)
        });
        const workEntries = new PSqlResourceInboxEntryRepository(sql, () => new Date(this.nowMs()));
        this.workReads = new TurnBatchedReads({
            toKeyId: toKeyAsString,
            readBatch: (keys) => readPSqlAdmissionWorkEntries(workEntries, keys)
        });
    }

    async ready(): Promise<void> {}

    /**
     * Autocommit gives each statement its own snapshot, never one across the chain, so the backend
     * is its own read session and every read is a fresh query. A chain that deliberately re-reads a
     * row -- the repair read, after it has captured the sender version that fences it -- must see
     * the row as it is now, not as some earlier statement found it. Reads issued in one turn share
     * one statement, which answers each of them no earlier than it asked. It returns the chain's own
     * promise rather than awaiting it: a session must not cost a caller an extra turn.
     */
    readWithin<T>(read: (session: ALAdmissionReadSession) => Promise<T>): Promise<T> {
        return read(this);
    }

    async readWork(key: Key): Promise<ResourceEntry | undefined> {
        return await this.workReads.read(key);
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        return await new PSqlAdmissionMutationCollector(this.toCollectorDependencies()).read(key, decode);
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        return await new PSqlAdmissionMutationCollector(this.toCollectorDependencies()).list(prefix, decode);
    }

    async write<T>(
        fn: (tx: ALAdmissionWorkWriteContext) => Promise<T>,
        executionExpiresAtMs: number | null = null
    ): Promise<T> {
        const collector = new PSqlAdmissionWorkWriteBuffer({
            collector: this.toCollectorDependencies(),
            readWork: (key) => this.workReads.read(key)
        });
        const result = await fn(collector);
        const mutations = collector.mutations();
        const workWrites = collector.workWrites();
        requireLivePersistenceWrite(executionExpiresAtMs, this.nowMs());
        if (mutations.length === 0 && workWrites.every((write) => write.kind === 'hold-claimed')) {
            return result;
        }
        try {
            await this.sql.begin(async (sql) => {
                requireLivePersistenceWrite(executionExpiresAtMs, this.nowMs());
                const transaction = createTransactionBoundPSqlRuntimeStateRepository(sql);
                const work = new PSqlResourceInboxEntryRepository(sql, () => new Date(this.nowMs()));
                await collector.writeMutations(transaction, mutations);
                for (const write of workWrites) {
                    if (!await writePSqlAdmissionWork(work, write)) {
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

    private toCollectorDependencies(): PSqlAdmissionMutationCollector.Dependencies {
        return {
            repository: this.repository,
            readEntry: (key) => this.stateReads.read(key),
            namespace: this.namespace,
            nowEpochMs: this.nowMs
        };
    }
}

type PSqlAdmissionWorkWrite =
    | { readonly kind: 'insert'; readonly values: ResourceInboxEntryInsertValues; }
    | { readonly kind: 'replace'; readonly computed: ResourceInboxObservedReplacement; }
    | { readonly kind: 'hold-claimed'; readonly observation: ResourceInboxObservation; };

namespace PSqlAdmissionWorkWriteBuffer {
    export interface Input {
        readonly collector: PSqlAdmissionMutationCollector.Dependencies;
        readonly readWork: (key: Key) => Promise<ResourceEntry | undefined>;
    }
}

class PSqlAdmissionWorkWriteBuffer extends PSqlAdmissionMutationCollector implements ALAdmissionWorkWriteContext {
    private readonly readStoredWork: (key: Key) => Promise<ResourceEntry | undefined>;
    private readonly workObservations = new Map<string, ResourceEntry | undefined>();
    private readonly claimedSlots = new Map<string, ResourceEntry>();
    private readonly pendingWork = new Map<string, ResourceEntry>();

    constructor(input: PSqlAdmissionWorkWriteBuffer.Input) {
        super(input.collector);
        this.readStoredWork = input.readWork;
    }

    async readWork(key: Key): Promise<ResourceEntry | undefined> {
        const keyString = toKeyAsString(key);
        const pending = this.pendingWork.get(keyString);
        if (pending !== undefined) {
            return toResourceEntrySnapshot(pending);
        }
        if (!this.workObservations.has(keyString)) {
            this.workObservations.set(keyString, await this.readStoredWork(key));
        }
        const observed = this.workObservations.get(keyString);
        return observed === undefined ? undefined : toResourceEntrySnapshot(observed);
    }

    /** Autocommit holds no snapshot to compare a re-read with, so the claim is the observation the commit fences. */
    async readClaimedWork(claimed: ResourceEntry): Promise<ResourceEntry | undefined> {
        const keyString = toKeyAsString(claimed.key);
        if (!this.workObservations.has(keyString)) {
            const snapshot = toResourceEntrySnapshot(claimed);
            this.workObservations.set(keyString, snapshot);
            this.claimedSlots.set(keyString, snapshot);
        }
        return await this.readWork(claimed.key);
    }

    writeWork(entry: ResourceEntry): void {
        const key = toKeyAsString(entry.key);
        if (!this.workObservations.has(key) || this.pendingWork.has(key)) {
            throw new TypeError('Admission work requires one write after its slot has been read');
        }
        this.pendingWork.set(key, toResourceEntrySnapshot(entry));
    }

    /** A hold on each claimed row the commit does not rewrite, then every pending write. */
    workWrites(): readonly PSqlAdmissionWorkWrite[] {
        const holds: PSqlAdmissionWorkWrite[] = [...this.claimedSlots]
            .filter(([key]) => !this.pendingWork.has(key))
            .map(([, claimed]) => ({ kind: 'hold-claimed', observation: computeResourceInboxObservation(claimed) }));
        return [
            ...holds,
            ...[...this.pendingWork].map(([key, entry]): PSqlAdmissionWorkWrite => {
                const expected = this.workObservations.get(key);
                return expected === undefined
                    ? { kind: 'insert', values: computeResourceInboxEntryInsertValues(entry) }
                    : { kind: 'replace', computed: computeResourceInboxObservedReplacement(expected, entry) };
            })
        ];
    }
}

async function writePSqlAdmissionWork(
    work: PSqlResourceInboxEntryRepository,
    write: PSqlAdmissionWorkWrite
): Promise<boolean> {
    switch (write.kind) {
        case 'insert':
            return await work.tryWriteComputedIfAbsentOrReplaceExpired(write.values) !== null;
        case 'replace':
            return await work.writeObservedReplacement(write.computed) !== null;
        case 'hold-claimed':
            return await work.lockObserved(write.observation);
    }
}

/** One key reads its row alone; several share the repository's batch read, one selector per key. */
async function readPSqlAdmissionStateEntries(
    repository: PSqlRuntimeStateRepository,
    namespace: string,
    keys: readonly string[]
): Promise<readonly (RuntimeStateEntry | undefined)[]> {
    if (keys.length === 1) {
        return [await repository.findEntry(namespace, keys[0]!)];
    }
    const selections = await repository.readRuntimeStateBatch(
        keys.map((key, index) => ({ selectorId: String(index), kind: 'key', namespace, key }))
    );
    const entries = new Map(selections.map((selection) => [selection.selectorId, selection.entries[0]]));
    return keys.map((_key, index) => entries.get(String(index)));
}

async function readPSqlAdmissionWorkEntries(
    entries: PSqlResourceInboxEntryRepository,
    keys: readonly Key[]
): Promise<readonly (ResourceEntry | undefined)[]> {
    if (keys.length === 1) {
        return [await entries.findByKey(keys[0]!) ?? undefined];
    }
    return await entries.findByKeys(keys);
}
