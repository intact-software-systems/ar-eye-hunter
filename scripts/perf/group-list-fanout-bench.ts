import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import { selectRuntimeStateReadBatch } from '@shared-server/runtime-state/read-batch/select-runtime-state-read-batch.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import {
    assertRuntimeStateExpectedRevision,
    assertRuntimeStateUpsertExpectedRevision
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { AuditStamp, Group, GroupMember, GroupPresenceSession } from '@shared/api/group-types.ts';

const GROUPS = Number(
    Deno.args.find((arg) => arg.startsWith('--groups='))?.slice('--groups='.length) ??
        '1000'
);
const RUNS = Number(
    Deno.args.find((arg) => arg.startsWith('--runs='))?.slice('--runs='.length) ??
        '3'
);
const OUT = Deno.args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length) ??
    'tmp/perf/results/group-list-fanout.json';

const scope = {
    applicationId: 'perf-app',
    workspaceId: 'perf-workspace'
};

interface RunResult {
    readonly run: number;
    readonly durationMs: number;
    readonly snapshots: number;
    readonly findEntryCalls: number;
    readonly findAllEntriesCalls: number;
    readonly findEntriesByPrefixCalls: number;
    readonly readRuntimeStateBatchCalls: number;
    readonly readRuntimeStateBatchCallsByNamespace: Readonly<Record<string, number>>;
    readonly maxRowsReturnedPerReadBatchSelector: number;
}

const EXPECTED_BATCH_READS = Object.freeze({
    'group-state:groups': 2,
    'group-state:members': 1,
    'group-state:presence-summaries': 1,
    'group-state:sessions': 1
});

async function main(): Promise<void> {
    const repository = new CountingRuntimeStateRepository();
    const groupRepository = new GroupStateRepository(repository);
    const service = createGroupStateService({
        runtimeRepository: repository,
        now: () => 1_700_000_000_000,
        serviceId: 'group-list-fanout-bench',
        authSessionRepository: new AuthSessionRepository(repository)
    });

    for (let index = 0; index < GROUPS; index += 1) {
        const groupId = `group-${String(index).padStart(6, '0')}`;
        const principalId = `principal-${String(index).padStart(6, '0')}`;
        const sessionId = `session-${String(index).padStart(6, '0')}`;
        await groupRepository.putGroup(createGroup(groupId, principalId));
        await groupRepository.putMember(createMember(groupId, principalId));
        await groupRepository
            .putPresenceSession(createPresenceSession(groupId, principalId, sessionId));
    }

    const results: RunResult[] = [];
    for (let run = 1; run <= RUNS; run += 1) {
        repository.resetCounters();
        const start = performance.now();
        const snapshots = await service.listSnapshots(scope);
        const durationMs = performance.now() - start;
        if (snapshots.length !== GROUPS) {
            throw new Error(`Expected ${GROUPS} snapshots, got ${snapshots.length}`);
        }
        const batchReads = repository.batchReadCounts();
        if (
            repository.readRuntimeStateBatchCalls !== 5 ||
            repository.findEntriesByPrefixCalls !== 0 ||
            repository.findEntryCalls !== 0 ||
            JSON.stringify(batchReads) !== JSON.stringify(EXPECTED_BATCH_READS)
        ) {
            throw new Error(
                `Expected bounded semantic batch reads ${
                    JSON.stringify(EXPECTED_BATCH_READS)
                } and no direct prefix or point reads, got ${
                    JSON.stringify(batchReads)
                }, ${repository.findEntriesByPrefixCalls} direct prefix reads, and ${repository.findEntryCalls} point reads`
            );
        }
        results.push({
            run,
            durationMs,
            snapshots: snapshots.length,
            findEntryCalls: repository.findEntryCalls,
            findAllEntriesCalls: repository.findAllEntriesCalls,
            findEntriesByPrefixCalls: repository.findEntriesByPrefixCalls,
            readRuntimeStateBatchCalls: repository.readRuntimeStateBatchCalls,
            readRuntimeStateBatchCallsByNamespace: batchReads,
            maxRowsReturnedPerReadBatchSelector: repository.maxRowsReturnedPerReadBatchSelector
        });
    }

    await Deno.mkdir(OUT.slice(0, OUT.lastIndexOf('/')), { recursive: true });
    await Deno.writeTextFile(
        OUT,
        `${
            JSON.stringify(
                {
                    benchmark: 'group-list-snapshots-fanout',
                    groups: GROUPS,
                    runs: RUNS,
                    results
                },
                null,
                2
            )
        }\n`
    );
}

function createGroup(groupId: string, ownerPrincipalId: string): Group {
    return {
        ...scope,
        groupId,
        slug: groupId,
        displayName: groupId,
        description: null,
        kind: 'room',
        status: 'active',
        archived: null,
        deleted: null,
        joinMode: 'open',
        maxMembers: null,
        maxSessionsPerMember: null,
        metadata: {},
        activeMemberCount: 1,
        ownerPrincipalId,
        lifecycleState: 'forming',
        formationEpoch: 0,
        formationAttemptCount: 0,
        lastFormationOutcome: null,
        establishmentStartedAtEpochMs: null,
        formationElectorate: [ownerPrincipalId],
        snapshotVersion: 1,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 1,
        created: createAuditStamp(1),
        updated: createAuditStamp(1),
        expiresAtEpochMs: null,
        emptySinceEpochMs: null,
        purgeAfterEpochMs: null
    };
}

function createMember(groupId: string, principalId: string): GroupMember {
    return {
        ...scope,
        groupId,
        principalId,
        role: 'owner',
        status: 'active',
        joined: createAuditStamp(1),
        updated: createAuditStamp(1),
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null
    };
}

function createPresenceSession(
    groupId: string,
    principalId: string,
    sessionId: string
): GroupPresenceSession {
    return {
        ...scope,
        groupId,
        principalId,
        sessionId,
        generationId: `${sessionId}:generation-1`,
        generationVersion: 1_700_000_000_000,
        status: 'active',
        connectedAtEpochMs: 1_700_000_000_000,
        lastHeartbeatAtEpochMs: 1_700_000_000_000,
        expiresAtEpochMs: 4_102_444_821_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function createAuditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'perf' },
        reason: null,
        traceId: null,
        requestId: null
    };
}

export class CountingRuntimeStateRepository implements RuntimeStateOptimisticTransactionalRepositoryLike {
    readonly data = new Map<string, RuntimeStateEntry>();
    findEntryCalls = 0;
    findAllEntriesCalls = 0;
    findEntriesByPrefixCalls = 0;
    readRuntimeStateBatchCalls = 0;
    readonly readRuntimeStateBatchCallsByNamespace = new Map<string, number>();
    maxRowsReturnedPerReadBatchSelector = 0;

    async begin<T>(
        fn: (repository: RuntimeStateOptimisticTransactionalRepositoryLike) => Promise<T>
    ): Promise<T> {
        return await fn(this);
    }

    findEntry(
        namespace: string,
        key: string
    ): Promise<RuntimeStateEntry | undefined> {
        this.findEntryCalls += 1;
        const entry = this.data.get(this.toKey(namespace, key));
        return Promise.resolve(entry ? { ...entry } : undefined);
    }

    findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        this.findAllEntriesCalls += 1;
        return Promise.resolve(
            [...this.data.entries()]
                .filter(([compositeKey]) => this.toNamespace(compositeKey) === namespace)
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key))
        );
    }

    readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        this.readRuntimeStateBatchCalls += 1;
        for (const { namespace } of selectors) {
            this.readRuntimeStateBatchCallsByNamespace.set(
                namespace,
                (this.readRuntimeStateBatchCallsByNamespace.get(namespace) ?? 0) + 1
            );
        }
        const selections = selectRuntimeStateReadBatch(
            [...this.data].map(([compositeKey, entry]) => ({
                namespace: this.toNamespace(compositeKey),
                entry
            })),
            selectors
        );
        this.maxRowsReturnedPerReadBatchSelector = Math.max(
            this.maxRowsReturnedPerReadBatchSelector,
            ...selections.map(({ entries }) => entries.length)
        );
        return Promise.resolve(selections);
    }

    findEntriesByPrefix(
        namespace: string,
        keyPrefix: string
    ): Promise<readonly RuntimeStateEntry[]> {
        this.findEntriesByPrefixCalls += 1;
        const rows = [...this.data.entries()]
            .filter(
                ([compositeKey]) =>
                    this.toNamespace(compositeKey) === namespace &&
                    this.toStoreKey(compositeKey).startsWith(keyPrefix)
            )
            .map(([, entry]) => ({ ...entry }))
            .sort((left, right) => left.key.localeCompare(right.key));
        return Promise.resolve(rows);
    }

    findEntriesByKeys(
        namespace: string,
        keys: readonly string[]
    ): Promise<readonly RuntimeStateEntry[]> {
        const keySet = new Set(keys);
        return Promise.resolve(
            [...this.data.entries()]
                .filter(([compositeKey]) =>
                    this.toNamespace(compositeKey) === namespace &&
                    keySet.has(this.toStoreKey(compositeKey))
                )
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key))
        );
    }

    upsert(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number
    ): Promise<void> {
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision: current ? current.revision + 1 : 0
        });
        return Promise.resolve();
    }

    insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number
    ): Promise<{ status: 'applied'; revision: number; } | { status: 'conflict'; }> {
        const compositeKey = this.toKey(namespace, key);
        if (this.data.has(compositeKey)) {
            return Promise.resolve({ status: 'conflict' });
        }
        this.data.set(compositeKey, this.entry(key, value, expireAtTimestamp, 0));
        return Promise.resolve({ status: 'applied', revision: 0 });
    }

    upsertIfRevision(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
        expectedRevision: number
    ): Promise<{ status: 'applied'; revision: number; } | { status: 'conflict'; }> {
        assertRuntimeStateUpsertExpectedRevision(expectedRevision);
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        if (!current || current.revision !== expectedRevision) {
            return Promise.resolve({ status: 'conflict' });
        }
        const revision = expectedRevision + 1;
        this.data.set(compositeKey, this.entry(key, value, expireAtTimestamp, revision));
        return Promise.resolve({ status: 'applied', revision });
    }

    deleteIfRevision(
        namespace: string,
        key: string,
        expectedRevision: number
    ): Promise<{ status: 'applied'; } | { status: 'conflict'; }> {
        assertRuntimeStateExpectedRevision(expectedRevision);
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        if (!current || current.revision !== expectedRevision) {
            return Promise.resolve({ status: 'conflict' });
        }
        this.data.delete(compositeKey);
        return Promise.resolve({ status: 'applied' });
    }

    deleteByKey(namespace: string, key: string): Promise<void> {
        this.data.delete(this.toKey(namespace, key));
        return Promise.resolve();
    }

    deleteExpired(namespace: string): Promise<number> {
        let deleted = 0;
        for (const [compositeKey, entry] of this.data.entries()) {
            if (
                this.toNamespace(compositeKey) === namespace &&
                entry.expireAtTimestamp <= Date.now()
            ) {
                this.data.delete(compositeKey);
                deleted += 1;
            }
        }
        return Promise.resolve(deleted);
    }

    lockKey(_namespace: string, _key: string): Promise<void> {
        return Promise.resolve();
    }

    resetCounters(): void {
        this.findEntryCalls = 0;
        this.findAllEntriesCalls = 0;
        this.findEntriesByPrefixCalls = 0;
        this.readRuntimeStateBatchCalls = 0;
        this.readRuntimeStateBatchCallsByNamespace.clear();
        this.maxRowsReturnedPerReadBatchSelector = 0;
    }

    batchReadCounts(): Readonly<Record<string, number>> {
        return Object.fromEntries(
            [...this.readRuntimeStateBatchCallsByNamespace.entries()].sort(([left], [right]) =>
                left.localeCompare(right)
            )
        );
    }

    private entry(
        key: string,
        value: string,
        expireAtTimestamp: number,
        revision: number
    ): RuntimeStateEntry {
        return {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision
        };
    }

    private toKey(namespace: string, key: string): string {
        return `${namespace}::${key}`;
    }

    private toNamespace(compositeKey: string): string {
        return compositeKey.split('::', 1)[0] ?? '';
    }

    private toStoreKey(compositeKey: string): string {
        return compositeKey.slice(this.toNamespace(compositeKey).length + 2);
    }
}

if (import.meta.main) {
    await main();
}
