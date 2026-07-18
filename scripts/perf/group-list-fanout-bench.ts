import type { Group, GroupMember, GroupPresenceSession } from '@shared/api/group-types.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import { createGroupStateService } from '@shared-server/rallar-system/services/group-state-service.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';

const GROUPS = Number(
    Deno.args.find((arg) => arg.startsWith('--groups='))?.slice('--groups='.length) ??
        '1000',
);
const RUNS = Number(
    Deno.args.find((arg) => arg.startsWith('--runs='))?.slice('--runs='.length) ??
        '3',
);
const OUT = Deno.args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length) ??
    'tmp/perf/results/group-list-fanout.json';

const scope = {
    applicationId: 'perf-app',
    workspaceId: 'perf-workspace',
};

const noOpPublisher: StateSyncPublisher = {
    publishClientSnapshot: async () => {},
    publishClientEvent: async () => {},
    publishGroupSnapshot: async () => {},
    publishGroupEvent: async () => {},
};

type RunResult = Readonly<{
    run: number;
    durationMs: number;
    snapshots: number;
    findEntryCalls: number;
    findAllEntriesCalls: number;
    findEntriesByPrefixCalls: number;
    maxRowsReturnedPerPrefixCall: number;
}>;

async function main(): Promise<void> {
    const repository = new CountingRuntimeStateRepository();
    const groupRepository = new GroupStateRepository(repository);
    const service = createGroupStateService({
        runtimeRepository: repository,
        syncPublisher: noOpPublisher,
        now: () => 1_700_000_000_000,
        serviceId: 'group-list-fanout-bench',
    });

    for (let index = 0; index < GROUPS; index += 1) {
        const groupId = `group-${String(index).padStart(6, '0')}`;
        const principalId = `principal-${String(index).padStart(6, '0')}`;
        const sessionId = `session-${String(index).padStart(6, '0')}`;
        await groupRepository.putGroup(createGroup(groupId));
        await groupRepository.putMember(createMember(groupId, principalId));
        await groupRepository.putPresenceSession(createPresenceSession(groupId, principalId, sessionId));
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
        if (repository.findEntriesByPrefixCalls !== 4 || repository.findEntryCalls !== 0) {
            throw new Error(
                `Expected four prefix reads and zero point reads, got ${repository.findEntriesByPrefixCalls} and ${repository.findEntryCalls}`,
            );
        }
        results.push({
            run,
            durationMs,
            snapshots: snapshots.length,
            findEntryCalls: repository.findEntryCalls,
            findAllEntriesCalls: repository.findAllEntriesCalls,
            findEntriesByPrefixCalls: repository.findEntriesByPrefixCalls,
            maxRowsReturnedPerPrefixCall: repository.maxRowsReturnedPerPrefixCall,
        });
    }

    await Deno.mkdir(OUT.slice(0, OUT.lastIndexOf('/')), { recursive: true });
    await Deno.writeTextFile(
        OUT,
        `${JSON.stringify({
            benchmark: 'group-list-snapshots-fanout',
            groups: GROUPS,
            runs: RUNS,
            results,
        }, null, 2)}\n`,
    );
}

function createGroup(groupId: string): Group {
    return {
        ...scope,
        groupId,
        slug: groupId,
        displayName: groupId,
        kind: 'room',
        status: 'active',
        joinMode: 'open',
        metadata: {},
        snapshotVersion: 1,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 1,
        created: { atEpochMs: 1, byServiceId: 'perf' },
        updated: { atEpochMs: 1, byServiceId: 'perf' },
    };
}

function createMember(groupId: string, principalId: string): GroupMember {
    return {
        ...scope,
        groupId,
        principalId,
        role: 'member',
        status: 'active',
        joined: { atEpochMs: 1, byServiceId: 'perf' },
        updated: { atEpochMs: 1, byServiceId: 'perf' },
    };
}

function createPresenceSession(
    groupId: string,
    principalId: string,
    sessionId: string,
): GroupPresenceSession {
    return {
        ...scope,
        groupId,
        principalId,
        sessionId,
        connectedAtEpochMs: 1_700_000_000_000,
        lastHeartbeatAtEpochMs: 1_700_000_000_000,
        expiresAtEpochMs: 4_102_444_821_000,
    };
}

class CountingRuntimeStateRepository implements RuntimeStateTransactionalRepositoryLike {
    readonly data = new Map<string, RuntimeStateEntry>();
    findEntryCalls = 0;
    findAllEntriesCalls = 0;
    findEntriesByPrefixCalls = 0;
    maxRowsReturnedPerPrefixCall = 0;

    async begin<T>(
        fn: (repository: RuntimeStateTransactionalRepositoryLike) => Promise<T>,
    ): Promise<T> {
        return await fn(this);
    }

    async findEntry(
        namespace: string,
        key: string,
    ): Promise<RuntimeStateEntry | undefined> {
        this.findEntryCalls += 1;
        const entry = this.data.get(this.toKey(namespace, key));
        return entry ? { ...entry } : undefined;
    }

    async findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        this.findAllEntriesCalls += 1;
        return [...this.data.entries()]
            .filter(([compositeKey]) => this.toNamespace(compositeKey) === namespace)
            .map(([, entry]) => ({ ...entry }))
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    async findEntriesByPrefix(
        namespace: string,
        keyPrefix: string,
    ): Promise<readonly RuntimeStateEntry[]> {
        this.findEntriesByPrefixCalls += 1;
        const rows = [...this.data.entries()]
            .filter(
                ([compositeKey]) =>
                    this.toNamespace(compositeKey) === namespace &&
                    this.toStoreKey(compositeKey).startsWith(keyPrefix),
            )
            .map(([, entry]) => ({ ...entry }))
            .sort((left, right) => left.key.localeCompare(right.key));
        this.maxRowsReturnedPerPrefixCall = Math.max(
            this.maxRowsReturnedPerPrefixCall,
            rows.length,
        );
        return rows;
    }

    async findEntriesByKeys(
        namespace: string,
        keys: readonly string[],
    ): Promise<readonly RuntimeStateEntry[]> {
        const keySet = new Set(keys);
        return [...this.data.entries()]
            .filter(([compositeKey]) =>
                this.toNamespace(compositeKey) === namespace &&
                keySet.has(this.toStoreKey(compositeKey))
            )
            .map(([, entry]) => ({ ...entry }))
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    async upsert(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<void> {
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision: current ? current.revision + 1 : 0,
        });
    }

    async deleteByKey(namespace: string, key: string): Promise<void> {
        this.data.delete(this.toKey(namespace, key));
    }

    async deleteExpired(namespace: string): Promise<number> {
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
        return deleted;
    }

    async lockKey(_namespace: string, _key: string): Promise<void> {}

    resetCounters(): void {
        this.findEntryCalls = 0;
        this.findAllEntriesCalls = 0;
        this.findEntriesByPrefixCalls = 0;
        this.maxRowsReturnedPerPrefixCall = 0;
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

await main();
