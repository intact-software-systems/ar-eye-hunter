import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import type { AuditStamp, ClientInstance, ClientPrincipal, ClientSession } from '@shared/api/client-types.ts';

const CLIENTS = Number(
    Deno.args.find((arg) => arg.startsWith('--clients='))?.slice('--clients='.length) ??
        '1000'
);
const RUNS = Number(
    Deno.args.find((arg) => arg.startsWith('--runs='))?.slice('--runs='.length) ??
        '3'
);
const OUT = Deno.args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length) ??
    'tmp/perf/results/client-list-fanout.json';

const scope = {
    applicationId: 'perf-app',
    workspaceId: 'perf-workspace'
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
    const clients = new ClientStateRepository(repository);
    const service = createClientStateService({
        runtimeRepository: repository,
        serviceId: 'client-list-fanout-bench'
    });

    for (let index = 0; index < CLIENTS; index += 1) {
        const principalId = `principal-${String(index).padStart(6, '0')}`;
        const clientInstanceId = `instance-${String(index).padStart(6, '0')}`;
        const sessionId = `session-${String(index).padStart(6, '0')}`;

        await requireApplied(clients.insertPrincipal(createPrincipal(principalId)));
        await requireApplied(clients.insertInstance(createInstance(principalId, clientInstanceId)));
        await requireApplied(
            clients.insertSession(createSession(principalId, clientInstanceId, sessionId))
        );
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
                `Expected four prefix reads and zero point reads, got ${repository.findEntriesByPrefixCalls} and ${repository.findEntryCalls}`
            );
        }
        results.push({
            run,
            durationMs,
            snapshots: snapshots.length,
            findEntryCalls: repository.findEntryCalls,
            findAllEntriesCalls: repository.findAllEntriesCalls,
            findEntriesByPrefixCalls: repository.findEntriesByPrefixCalls,
            maxRowsReturnedPerPrefixCall: repository.maxRowsReturnedPerPrefixCall
        });
    }

    await Deno.mkdir(OUT.slice(0, OUT.lastIndexOf('/')), { recursive: true });
    await Deno.writeTextFile(
        OUT,
        `${
            JSON.stringify(
                {
                    benchmark: 'client-list-snapshots-fanout',
                    clients: CLIENTS,
                    runs: RUNS,
                    results
                },
                null,
                2
            )
        }\n`
    );
}

class CountingRuntimeStateRepository implements RuntimeStateOptimisticTransactionalRepositoryLike {
    readonly data = new Map<string, RuntimeStateEntry>();
    findEntryCalls = 0;
    findAllEntriesCalls = 0;
    findEntriesByPrefixCalls = 0;
    maxRowsReturnedPerPrefixCall = 0;

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
        this.maxRowsReturnedPerPrefixCall = Math.max(
            this.maxRowsReturnedPerPrefixCall,
            rows.length
        );
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
    ): Promise<RuntimeStateConditionalWriteResult> {
        const compositeKey = this.toKey(namespace, key);
        if (this.data.has(compositeKey)) {
            return Promise.resolve({ status: 'conflict' });
        }
        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision: 0
        });
        return Promise.resolve({ status: 'applied', revision: 0 });
    }

    upsertIfRevision(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        if (current?.revision !== expectedRevision) {
            return Promise.resolve({ status: 'conflict' });
        }
        const revision = expectedRevision + 1;
        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision
        });
        return Promise.resolve({ status: 'applied', revision });
    }

    deleteIfRevision(
        namespace: string,
        key: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        const compositeKey = this.toKey(namespace, key);
        if (this.data.get(compositeKey)?.revision !== expectedRevision) {
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

async function requireApplied(
    pending: Promise<RuntimeStateConditionalWriteResult>
): Promise<void> {
    const result = await pending;
    if (result.status !== 'applied') {
        throw new Error('Client fanout benchmark seed write conflicted.');
    }
}

function createPrincipal(principalId: string): ClientPrincipal {
    return {
        ...scope,
        principalId,
        username: principalId,
        displayName: null,
        avatarUrl: null,
        authProvider: null,
        externalSubjectId: null,
        roles: [],
        metadata: {},
        snapshotVersion: 1,
        profileVersion: 1,
        presenceVersion: 1,
        status: 'active',
        created: BENCHMARK_AUDIT_STAMP,
        updated: BENCHMARK_AUDIT_STAMP,
        disabled: null,
        deleted: null,
        lastSeenAtEpochMs: null
    };
}

function createInstance(principalId: string, clientInstanceId: string): ClientInstance {
    return {
        ...scope,
        principalId,
        clientInstanceId,
        platform: 'web',
        deviceLabel: null,
        appVersion: null,
        userAgent: null,
        capabilities: [],
        status: 'active',
        registered: BENCHMARK_AUDIT_STAMP,
        updated: BENCHMARK_AUDIT_STAMP,
        revoked: null
    };
}

function createSession(
    principalId: string,
    clientInstanceId: string,
    sessionId: string
): ClientSession {
    return {
        ...scope,
        principalId,
        clientInstanceId,
        sessionId,
        generationId: `${sessionId}-generation`,
        generationVersion: 1,
        status: 'active',
        presenceState: 'online',
        transport: 'ws',
        connectionId: null,
        authenticatedAtEpochMs: BENCHMARK_NOW_EPOCH_MS,
        connectedAtEpochMs: BENCHMARK_NOW_EPOCH_MS,
        lastHeartbeatAtEpochMs: BENCHMARK_NOW_EPOCH_MS,
        expiresAtEpochMs: 4_102_444_821_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

const BENCHMARK_NOW_EPOCH_MS = 1_700_000_000_000;
const BENCHMARK_AUDIT_STAMP: AuditStamp = {
    atEpochMs: BENCHMARK_NOW_EPOCH_MS,
    actor: { kind: 'service', serviceId: 'client-list-fanout-bench' },
    reason: null,
    traceId: null,
    requestId: null
};

await main();
