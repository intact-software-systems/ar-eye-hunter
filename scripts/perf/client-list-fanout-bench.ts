import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import { createClientStateService } from '@shared-server/rallar-system/services/client-state-service.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';

const CLIENTS = Number(
    Deno.args.find((arg) => arg.startsWith('--clients='))?.slice('--clients='.length) ??
        '1000',
);
const RUNS = Number(
    Deno.args.find((arg) => arg.startsWith('--runs='))?.slice('--runs='.length) ??
        '3',
);
const OUT = Deno.args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length) ??
    'tmp/perf/results/client-list-fanout.json';

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
    const service = createClientStateService({
        runtimeRepository: repository,
        syncPublisher: noOpPublisher,
        now: () => 1_700_000_000_000,
        serviceId: 'client-list-fanout-bench',
    });

    for (let index = 0; index < CLIENTS; index += 1) {
        const principalId = `principal-${String(index).padStart(6, '0')}`;
        const clientInstanceId = `instance-${String(index).padStart(6, '0')}`;
        const sessionId = `session-${String(index).padStart(6, '0')}`;

        await service.upsertPrincipal(scope, principalId, {
            username: principalId,
            actorPrincipalId: principalId,
        });
        await service.upsertInstance(scope, principalId, clientInstanceId, {
            platform: 'web',
            actorPrincipalId: principalId,
        });
        await service.connectSession(scope, principalId, clientInstanceId, sessionId, {
            presenceState: 'online',
            actorPrincipalId: principalId,
            actorSessionId: sessionId,
            lastHeartbeatAtEpochMs: 1_700_000_000_000,
            expiresAtEpochMs: 4_102_444_821_000,
        });
    }

    const results: RunResult[] = [];
    for (let run = 1; run <= RUNS; run += 1) {
        repository.resetCounters();
        const start = performance.now();
        const snapshots = await service.listSnapshots(scope);
        const durationMs = performance.now() - start;
        if (snapshots.length !== CLIENTS) {
            throw new Error(`Expected ${CLIENTS} snapshots, got ${snapshots.length}`);
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
            benchmark: 'client-list-snapshots-fanout',
            clients: CLIENTS,
            runs: RUNS,
            results,
        }, null, 2)}\n`,
    );
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
