import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { ObservableLatestRepository } from '@shared/cache/ObservableLatestRepository.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { RateLimiterPolicy } from '@shared/resilience/Resilience.ts';
import {
    readRuntimeStateEntriesByPrefix,
    RUNTIME_STATE_PREFIX_READ_PAGE_SIZE,
} from '@shared-server/postgres/al-runtime/runtime-state-prefix-reader.ts';
import { filterStateEventsForList } from '@shared-server/rallar-system/state-event-listing.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateEntryPageOptions,
    RuntimeStateTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { resolveStateSyncRecipients } from '@shared-server/rallar-system/state-sync-routing.ts';
import { readRateLimiter } from '@shared-server/http/rate-limit-service.ts';

type JsonRecord = Record<string, unknown>;

type BenchResult = {
    name: string;
    sizeLabel: string;
    run: number;
    durationMs: number;
    memoryBefore: Deno.MemoryUsage;
    memoryAfter: Deno.MemoryUsage;
    details: JsonRecord;
};

const OUT = Deno.args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length) ??
    'tmp/perf/results/runtime-validation-bench.json';
const MODE = Deno.args.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length) ??
    'full';
const RUNS = Number(Deno.args.find((arg) => arg.startsWith('--runs='))?.slice('--runs='.length) ?? '3');

const gc = () => {
    const maybeGc = (globalThis as unknown as { gc?: () => void }).gc;
    maybeGc?.();
};

function now(): number {
    return performance.now();
}

function memory(): Deno.MemoryUsage {
    gc();
    return Deno.memoryUsage();
}

async function measure(
    name: string,
    sizeLabel: string,
    run: number,
    details: JsonRecord,
    action: () => unknown | Promise<unknown>,
): Promise<BenchResult> {
    const memoryBefore = memory();
    const start = now();
    await action();
    const durationMs = now() - start;
    const memoryAfter = memory();
    return {
        name,
        sizeLabel,
        run,
        durationMs,
        memoryBefore,
        memoryAfter,
        details,
    };
}

async function waitUntil(
    condition: () => boolean,
    options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 2_000;
    const pollMs = options.pollMs ?? 1;
    const deadline = now() + timeoutMs;

    while (!condition()) {
        if (now() >= deadline) {
            throw new Error('Timed out waiting for benchmark condition');
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
}

function makeEvent(index: number): JsonRecord {
    return {
        eventId: `event-${String(index).padStart(8, '0')}`,
        eventType: index % 5 === 0 ? 'presence' : 'snapshot',
        snapshotVersion: index,
        occurredAtEpochMs: 1_700_000_000_000 + index,
        applicationId: 'app',
        workspaceId: 'workspace',
        principalId: 'principal-hot',
        payload: {
            text: `payload-${index}`,
            values: [index, index + 1, index + 2, index + 3],
        },
    };
}

function runLegacyEventPipeline(rowJson: readonly string[], limit: number): number {
    const parsed = rowJson.map((value) => JSON.parse(value));
    return filterStateEventsForList(parsed as never[], { limit }).length;
}

function runPagedEventPipeline(rowJson: readonly string[], limit: number): number {
    const pageRows = rowJson.slice(-limit);
    const parsed = pageRows.map((value) => JSON.parse(value));
    return parsed.length;
}

function runRecentEventPipeline(rowJson: readonly string[], limit: number): number {
    const recentRows = rowJson.slice(-limit);
    const parsed = recentRows.map((value) => JSON.parse(value));
    return filterStateEventsForList(parsed as never[], { limit }).length;
}

function makeRuntimeStateEntries(size: number): readonly RuntimeStateEntry[] {
    return Array.from({ length: size }, (_, index) => ({
        key: `prefix:${String(index).padStart(8, '0')}`,
        value: JSON.stringify({
            kind: 'runtime',
            sequence: index,
            payload: 'x'.repeat(512),
        }),
        expireAtTimestamp: Date.now() + 86_400_000,
        updatedTimestamp: new Date(1_700_000_000_000 + index).toISOString(),
        revision: 0,
    }));
}

class RuntimeStatePrefixBenchRepository
    implements RuntimeStateTransactionalRepositoryLike {
    findEntriesByPrefixCalls = 0;
    findEntriesByPrefixPageCalls = 0;
    maxRowsReturned = 0;

    public constructor(
        private readonly entries: readonly RuntimeStateEntry[],
        private readonly namespace = 'perf-runtime-20260702',
    ) {}

    async begin<T>(
        fn: (repository: RuntimeStateTransactionalRepositoryLike) => Promise<T>,
    ): Promise<T> {
        return await fn(this);
    }

    async findEntry(): Promise<RuntimeStateEntry | undefined> {
        return undefined;
    }

    async findAllEntries(): Promise<readonly RuntimeStateEntry[]> {
        return [];
    }

    async findEntriesByPrefix(
        namespace: string,
        keyPrefix: string,
    ): Promise<readonly RuntimeStateEntry[]> {
        this.findEntriesByPrefixCalls += 1;
        const rows = this.entries
            .filter((entry) =>
                namespace === this.namespace && entry.key.startsWith(keyPrefix)
            )
            .map((entry) => ({ ...entry }));
        this.maxRowsReturned = Math.max(this.maxRowsReturned, rows.length);
        return rows;
    }

    async findEntriesByPrefixPage(
        namespace: string,
        keyPrefix: string,
        options: RuntimeStateEntryPageOptions,
    ): Promise<readonly RuntimeStateEntry[]> {
        this.findEntriesByPrefixPageCalls += 1;
        const rows: RuntimeStateEntry[] = [];
        if (namespace !== this.namespace) {
            return rows;
        }

        let index = options.afterKey === undefined
            ? 0
            : this.findFirstKeyAfter(options.afterKey);

        for (; index < this.entries.length && rows.length < options.limit; index++) {
            const entry = this.entries[index];
            if (!entry.key.startsWith(keyPrefix)) {
                if (rows.length > 0) {
                    break;
                }
                continue;
            }
            rows.push({ ...entry });
        }
        this.maxRowsReturned = Math.max(this.maxRowsReturned, rows.length);
        return rows;
    }

    private findFirstKeyAfter(key: string): number {
        let low = 0;
        let high = this.entries.length;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (this.entries[mid].key.localeCompare(key) <= 0) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        return low;
    }

    async upsert(): Promise<void> {}

    async deleteByKey(): Promise<void> {}

    async deleteExpired(): Promise<number> {
        return 0;
    }

    async lockKey(): Promise<void> {}
}

async function benchRuntimePrefix(results: BenchResult[]): Promise<void> {
    const sizes = [1_000, 10_000, 100_000];
    const namespace = 'perf-runtime-20260702';
    const prefix = 'prefix:';

    for (const size of sizes) {
        const entries = makeRuntimeStateEntries(size);
        for (let run = 1; run <= RUNS; run++) {
            const fullRepo = new RuntimeStatePrefixBenchRepository(entries, namespace);
            const fullDetails: JsonRecord = {
                rows: size,
                pageSize: undefined,
            };
            results.push(await measure(
                'runtime-prefix.full-materialize-and-parse',
                `${size} rows`,
                run,
                fullDetails,
                async () => {
                    let parsed = 0;
                    for (const entry of await fullRepo.findEntriesByPrefix(namespace, prefix)) {
                        JSON.parse(entry.value);
                        parsed += 1;
                    }
                    if (parsed !== size) {
                        throw new Error(`Expected ${size} parsed rows, got ${parsed}`);
                    }
                    fullDetails.findEntriesByPrefixCalls = fullRepo.findEntriesByPrefixCalls;
                    fullDetails.findEntriesByPrefixPageCalls = fullRepo.findEntriesByPrefixPageCalls;
                    fullDetails.maxRowsReturnedPerRepositoryCall = fullRepo.maxRowsReturned;
                },
            ));

            const pagedRepo = new RuntimeStatePrefixBenchRepository(entries, namespace);
            const pagedDetails: JsonRecord = {
                rows: size,
                pageSize: RUNTIME_STATE_PREFIX_READ_PAGE_SIZE,
            };
            results.push(await measure(
                'runtime-prefix.paged-read-and-parse',
                `${size} rows`,
                run,
                pagedDetails,
                async () => {
                    let parsed = 0;
                    for await (
                        const entry of readRuntimeStateEntriesByPrefix(
                            pagedRepo,
                            namespace,
                            prefix,
                        )
                    ) {
                        JSON.parse(entry.value);
                        parsed += 1;
                    }
                    if (parsed !== size) {
                        throw new Error(`Expected ${size} parsed rows, got ${parsed}`);
                    }
                    pagedDetails.findEntriesByPrefixCalls = pagedRepo.findEntriesByPrefixCalls;
                    pagedDetails.findEntriesByPrefixPageCalls = pagedRepo.findEntriesByPrefixPageCalls;
                    pagedDetails.maxRowsReturnedPerRepositoryCall = pagedRepo.maxRowsReturned;
                },
            ));
        }
    }
}

async function benchEvents(results: BenchResult[]): Promise<void> {
    const sizes = [100, 10_000, 100_000];
    const limit = 100;
    for (const size of sizes) {
        const rows = Array.from({ length: size }, (_, index) => JSON.stringify(makeEvent(index)));
        const bytes = rows.reduce((sum, row) => sum + row.length, 0);
        for (let run = 1; run <= RUNS; run++) {
            results.push(await measure(
                'events.legacy.parse-all-and-slice',
                `${size} rows`,
                run,
                { rows: size, rowBytes: bytes, limit },
                () => runLegacyEventPipeline(rows, limit),
            ));
            results.push(await measure(
                'events.page.parse-page-only',
                `${size} rows`,
                run,
                { rows: size, parsedRows: limit, rowBytes: rows.slice(-limit).join('').length, limit },
                () => runPagedEventPipeline(rows, limit),
            ));
            results.push(await measure(
                'events.recent.parse-bounded-tail',
                `${size} rows`,
                run,
                { rows: size, parsedRows: limit, rowBytes: rows.slice(-limit).join('').length, limit },
                () => runRecentEventPipeline(rows, limit),
            ));
        }
    }
}

async function benchCacheRetention(results: BenchResult[]): Promise<void> {
    const sizes = [1_000, 10_000, 100_000];
    for (const size of sizes) {
        for (let run = 1; run <= RUNS; run++) {
            const repo = new ObservableLatestRepository<string, JsonRecord>({ ttlMs: 0 });
            results.push(await measure(
                'cache.observable-expired-retained-before-delete',
                `${size} keys`,
                run,
                { keys: size, ttlMs: 0 },
                async () => {
                    for (let i = 0; i < size; i++) {
                        repo.set(`key-${i}`, { i, value: `value-${i}` });
                    }
                    await new Promise((resolve) => setTimeout(resolve, 2));
                    const liveValues = repo.readAllValues().length;
                    if (liveValues !== 0) {
                        throw new Error(`Expected zero live values, got ${liveValues}`);
                    }
                },
            ));
            results.push({
                name: 'cache.observable-size-after-expiry',
                sizeLabel: `${size} keys`,
                run,
                durationMs: 0,
                memoryBefore: memory(),
                memoryAfter: memory(),
                details: {
                    keys: size,
                    retainedEntryCount: repo.size(),
                    liveValueCount: repo.readAllValues().length,
                },
            });
            results.push(await measure(
                'cache.observable-delete-expired',
                `${size} keys`,
                run,
                { keys: size },
                () => repo.deleteExpired(),
            ));
            results.push({
                name: 'cache.observable-size-after-delete',
                sizeLabel: `${size} keys`,
                run,
                durationMs: 0,
                memoryBefore: memory(),
                memoryAfter: memory(),
                details: {
                    keys: size,
                    retainedEntryCount: repo.size(),
                    liveValueCount: repo.readAllValues().length,
                },
            });

            const autoRepo = new ObservableLatestRepository<string, JsonRecord>({
                ttlMs: 0,
                deleteExpiredIntervalMs: 1,
            });
            try {
                results.push(await measure(
                    'cache.observable-auto-delete-expired',
                    `${size} keys`,
                    run,
                    { keys: size, ttlMs: 0, deleteExpiredIntervalMs: 1 },
                    async () => {
                        for (let i = 0; i < size; i++) {
                            autoRepo.set(`auto-key-${i}`, {
                                i,
                                value: `value-${i}`,
                            });
                        }
                        await waitUntil(() => autoRepo.size() === 0);
                    },
                ));
                results.push({
                    name: 'cache.observable-size-after-auto-delete',
                    sizeLabel: `${size} keys`,
                    run,
                    durationMs: 0,
                    memoryBefore: memory(),
                    memoryAfter: memory(),
                    details: {
                        keys: size,
                        retainedEntryCount: autoRepo.size(),
                        liveValueCount: autoRepo.readAllValues().length,
                    },
                });
            } finally {
                autoRepo.dispose();
            }
        }
    }
}

async function benchRateLimiter(results: BenchResult[]): Promise<void> {
    const policy = new RateLimiterPolicy(60_000, 1_000_000);
    const sizes = [100, 1_000, 5_000];
    for (const size of sizes) {
        for (let i = 0; i < size; i++) {
            readRateLimiter('bench', `warm-${size}-${i}`, policy);
        }
        for (let run = 1; run <= RUNS; run++) {
            results.push(await measure(
                'rate-limiter.read-with-cache-size',
                `${size} cached keys`,
                run,
                { cachedKeysApprox: size, reads: 100 },
                () => {
                    for (let i = 0; i < 100; i++) {
                        readRateLimiter('bench', `probe-${size}-${run}-${i}`, policy).allow();
                    }
                },
            ));
        }
    }
}

class FakeSocket {
    readyState = WebSocket.OPEN;
    sentBytes = 0;
    sentCount = 0;
    addEventListener(_type: string, _listener: unknown): void {}
    close(): void {
        this.readyState = WebSocket.CLOSED;
    }
    send(data: string): void {
        this.sentBytes += data.length;
        this.sentCount += 1;
    }
}

type EncodedFakeSocketMessage = Readonly<{
    text: string;
}>;

function makeClientSnapshot(index: number, sessionsPerClient: number, liveUntil: number): ClientSnapshot {
    return {
        principal: {
            applicationId: 'app',
            workspaceId: 'workspace',
            principalId: `principal-${index}`,
            username: `principal-${index}`,
            status: 'active',
            roles: [],
            metadata: {},
            snapshotVersion: index + 1,
            profileVersion: index + 1,
            presenceVersion: index + 1,
            created: { atEpochMs: 1, byServiceId: 'perf' },
            updated: { atEpochMs: 1, byServiceId: 'perf' },
        },
        instances: [],
        activeSessions: Array.from({ length: sessionsPerClient }, (_, sessionIndex) => ({
            applicationId: 'app',
            workspaceId: 'workspace',
            principalId: `principal-${index}`,
            clientInstanceId: `instance-${index}`,
            sessionId: `session-${index}-${sessionIndex}`,
            status: 'active',
            presenceState: 'online',
            transport: 'ws',
            connectedAtEpochMs: 1_700_000_000_000,
            authenticatedAtEpochMs: 1_700_000_000_000,
            lastHeartbeatAtEpochMs: liveUntil - 1_000,
            expiresAtEpochMs: liveUntil,
        })),
        isOnline: true,
        activeSessionCount: sessionsPerClient,
    } as unknown as ClientSnapshot;
}

function makeGroupSnapshot(
    groupIndex: number,
    memberCount: number,
    sessionsPerClient: number,
    liveUntil: number,
): GroupSnapshot {
    return {
        group: {
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: `group-${groupIndex}`,
            displayName: `Group ${groupIndex}`,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: groupIndex + 1,
            metadataVersion: groupIndex + 1,
            rosterVersion: groupIndex + 1,
            presenceVersion: groupIndex + 1,
            created: { atEpochMs: 1, byServiceId: 'perf' },
            updated: { atEpochMs: 1, byServiceId: 'perf' },
        },
        members: Array.from({ length: memberCount }, (_, index) => ({
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: `group-${groupIndex}`,
            principalId: `principal-${index}`,
            role: 'member',
            status: 'active',
            joined: { atEpochMs: 1_700_000_000_000, byServiceId: 'perf' },
            updated: { atEpochMs: 1_700_000_000_000, byServiceId: 'perf' },
        })),
        activeSessions: Array.from({ length: memberCount * sessionsPerClient }, (_, index) => ({
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: `group-${groupIndex}`,
            sessionId: `session-${Math.floor(index / sessionsPerClient)}-${index % sessionsPerClient}`,
            principalId: `principal-${Math.floor(index / sessionsPerClient)}`,
            connectedAtEpochMs: 1_700_000_000_000,
            lastHeartbeatAtEpochMs: liveUntil - 1_000,
            expiresAtEpochMs: liveUntil,
        })),
        memberCount,
        onlineMemberCount: memberCount,
    } as unknown as GroupSnapshot;
}

function makeWsServer(connectionIds: readonly string[]): {
    connections: Map<string, { id: string; socket: FakeSocket; isOpen: boolean }>;
    broadcast: (data: unknown, filter?: (ctx: { id: string; isOpen: boolean }) => boolean) => number;
    encode: (data: unknown) => EncodedFakeSocketMessage;
    sendEncoded: (connectionId: string, encoded: EncodedFakeSocketMessage) => void;
} {
    const connections = new Map<string, { id: string; socket: FakeSocket; isOpen: boolean }>();
    for (const id of connectionIds) {
        connections.set(id, { id, socket: new FakeSocket(), isOpen: true });
    }
    return {
        connections,
        encode(data: unknown): EncodedFakeSocketMessage {
            return {
                text: JSON.stringify(data),
            };
        },
        sendEncoded(connectionId: string, encoded: EncodedFakeSocketMessage): void {
            const ctx = connections.get(connectionId);
            if (!ctx || !ctx.isOpen) {
                throw new Error(`Connection not open: ${connectionId}`);
            }
            ctx.socket.send(encoded.text);
        },
        broadcast(data: unknown, filter?: (ctx: { id: string; isOpen: boolean }) => boolean): number {
            const encoded = JSON.stringify(data);
            let count = 0;
            for (const ctx of connections.values()) {
                if (!ctx.isOpen) continue;
                if (filter && !filter(ctx)) continue;
                ctx.socket.send(encoded);
                count += 1;
            }
            return count;
        },
    };
}

async function benchStateSync(results: BenchResult[]): Promise<void> {
    const nowEpochMs = Date.now();
    const liveUntilEpochMs = nowEpochMs + 60_000;
    const sizes = [
        { clients: 10, sessionsPerClient: 1, groups: 10, members: 10 },
        { clients: 100, sessionsPerClient: 1, groups: 100, members: 100 },
        { clients: 500, sessionsPerClient: 1, groups: 1_000, members: 100 },
    ];
    for (const size of sizes) {
        const clientSnapshots = Array.from(
            { length: size.clients },
            (_, index) => makeClientSnapshot(index, size.sessionsPerClient, liveUntilEpochMs),
        );
        const connectionIds = clientSnapshots.flatMap((snapshot) =>
            snapshot.activeSessions.map((session) => session.sessionId)
        );
        const webSocketServer = makeWsServer(connectionIds);
        const groupSnapshot = makeGroupSnapshot(
            0,
            Math.min(size.members, size.clients),
            size.sessionsPerClient,
            liveUntilEpochMs,
        );
        const message = {
            id: 'message-1',
            payload: {
                typeId: AppTopics.groupStateSnapshot,
                resource: JSON.stringify(groupSnapshot),
            },
        };

        for (let run = 1; run <= RUNS; run++) {
            results.push(await measure(
                'state-sync.resolve-group-recipients',
                `${size.clients} clients/${size.groups} groups label`,
                run,
                {
                    clients: size.clients,
                    sessionsPerClient: size.sessionsPerClient,
                    groupsLabel: size.groups,
                    members: groupSnapshot.members.length,
                    connections: connectionIds.length,
                },
                () => {
                    const recipients = resolveStateSyncRecipients(
                        webSocketServer as never,
                        message as never,
                        {
                            readClientSnapshots: () => clientSnapshots,
                            now: () => nowEpochMs,
                        },
                    );
                    if (!recipients || recipients.length === 0) {
                        throw new Error('Expected recipients');
                    }
                },
            ));
        }
    }
}

async function benchSerialization(results: BenchResult[]): Promise<void> {
    const recipientCounts = [1, 10, 100, 500];
    const payloadSizes = [1_024, 32_768, 262_144];
    for (const recipients of recipientCounts) {
        for (const payloadBytes of payloadSizes) {
            const connectionIds = Array.from({ length: recipients }, (_, index) => `conn-${index}`);
            const server = makeWsServer(connectionIds);
            const payload = { type: 'payload', body: 'x'.repeat(payloadBytes) };
            for (let run = 1; run <= RUNS; run++) {
                results.push(await measure(
                    'ws.broadcast-encode-once',
                    `${recipients} recipients/${payloadBytes} bytes`,
                    run,
                    { recipients, payloadBytes },
                    () => {
                        server.broadcast(payload);
                    },
                ));
                results.push(await measure(
                    'ws.direct-send-stringify-per-recipient',
                    `${recipients} recipients/${payloadBytes} bytes`,
                    run,
                    { recipients, payloadBytes },
                    () => {
                        for (const id of connectionIds) {
                            const ctx = server.connections.get(id);
                            if (!ctx) throw new Error('missing ctx');
                            ctx.socket.send(JSON.stringify(payload));
                        }
                    },
                ));
                results.push(await measure(
                    'ws.direct-send-encoded-once',
                    `${recipients} recipients/${payloadBytes} bytes`,
                    run,
                    { recipients, payloadBytes },
                    () => {
                        const encoded = server.encode(payload);
                        for (const id of connectionIds) {
                            server.sendEncoded(id, encoded);
                        }
                    },
                ));
            }
        }
    }
}

async function benchLatestRepositoryCleanup(results: BenchResult[]): Promise<void> {
    const sizes = [1_000, 10_000, 100_000];
    for (const size of sizes) {
        for (let run = 1; run <= RUNS; run++) {
            const repo = new LatestRepository<string, JsonRecord>({ ttlMs: 0 });
            for (let i = 0; i < size; i++) {
                repo.set(`key-${i}`, { i });
            }
            await new Promise((resolve) => setTimeout(resolve, 2));
            results.push(await measure(
                'latest-repository.delete-expired',
                `${size} keys`,
                run,
                { keys: size },
                () => repo.deleteExpired(),
            ));
        }
    }
}

async function benchCacheLeakChurn(results: BenchResult[]): Promise<void> {
    const repo = new ObservableLatestRepository<string, JsonRecord>({ ttlMs: 0 });
    const batchSize = 10_000;
    const batches = 10;
    for (let batch = 1; batch <= batches; batch++) {
        const firstKey = (batch - 1) * batchSize;
        await measure(
            'cache.leak-churn-insert-batch',
            `${batch * batchSize} cumulative keys`,
            1,
            { batch, batchSize },
            async () => {
                for (let i = 0; i < batchSize; i++) {
                    const keyIndex = firstKey + i;
                    repo.set(`churn-${keyIndex}`, {
                        keyIndex,
                        payload: `payload-${keyIndex}`,
                    });
                }
                await new Promise((resolve) => setTimeout(resolve, 2));
                repo.readAllValues();
            },
        );
        results.push({
            name: 'cache.leak-churn-post-expiry',
            sizeLabel: `${batch * batchSize} cumulative keys`,
            run: 1,
            durationMs: 0,
            memoryBefore: memory(),
            memoryAfter: memory(),
            details: {
                batch,
                batchSize,
                retainedEntryCount: repo.size(),
                liveValueCount: repo.readAllValues().length,
            },
        });
    }
    results.push(await measure(
        'cache.leak-churn-delete-expired',
        `${batchSize * batches} cumulative keys`,
        1,
        { batchSize, batches },
        () => repo.deleteExpired(),
    ));
    results.push({
        name: 'cache.leak-churn-after-delete',
        sizeLabel: `${batchSize * batches} cumulative keys`,
        run: 1,
        durationMs: 0,
        memoryBefore: memory(),
        memoryAfter: memory(),
        details: {
            retainedEntryCount: repo.size(),
            liveValueCount: repo.readAllValues().length,
        },
    });
}

async function benchCacheAutoEvictionChurn(results: BenchResult[]): Promise<void> {
    const repo = new ObservableLatestRepository<string, JsonRecord>({
        ttlMs: 0,
        deleteExpiredIntervalMs: 1,
    });
    const batchSize = 10_000;
    const batches = 10;

    try {
        for (let batch = 1; batch <= batches; batch++) {
            const firstKey = (batch - 1) * batchSize;
            results.push(await measure(
                'cache.auto-eviction-churn-insert-batch',
                `${batch * batchSize} cumulative keys`,
                1,
                { batch, batchSize, deleteExpiredIntervalMs: 1 },
                async () => {
                    for (let i = 0; i < batchSize; i++) {
                        const keyIndex = firstKey + i;
                        repo.set(`auto-churn-${keyIndex}`, {
                            keyIndex,
                            payload: `payload-${keyIndex}`,
                        });
                    }
                    await waitUntil(() => repo.size() === 0);
                },
            ));
            results.push({
                name: 'cache.auto-eviction-churn-post-expiry',
                sizeLabel: `${batch * batchSize} cumulative keys`,
                run: 1,
                durationMs: 0,
                memoryBefore: memory(),
                memoryAfter: memory(),
                details: {
                    batch,
                    batchSize,
                    retainedEntryCount: repo.size(),
                    liveValueCount: repo.readAllValues().length,
                },
            });
        }
    } finally {
        repo.dispose();
    }
}

async function main(): Promise<void> {
    const results: BenchResult[] = [];
    if (MODE === 'full' || MODE === 'events') await benchEvents(results);
    if (MODE === 'full' || MODE === 'runtime-prefix') await benchRuntimePrefix(results);
    if (MODE === 'full' || MODE === 'cache') await benchCacheRetention(results);
    if (MODE === 'full' || MODE === 'rate-limit') await benchRateLimiter(results);
    if (MODE === 'full' || MODE === 'state-sync') await benchStateSync(results);
    if (MODE === 'full' || MODE === 'serialization') await benchSerialization(results);
    if (MODE === 'full' || MODE === 'latest-cleanup') await benchLatestRepositoryCleanup(results);
    if (MODE === 'full' || MODE === 'leak') {
        await benchCacheLeakChurn(results);
        await benchCacheAutoEvictionChurn(results);
    }

    const payload = {
        generatedAt: new Date().toISOString(),
        commandArgs: Deno.args,
        mode: MODE,
        runs: RUNS,
        deno: Deno.version,
        results,
    };
    await Deno.writeTextFile(OUT, JSON.stringify(payload, null, 2));
    console.log(`Wrote ${results.length} benchmark results to ${OUT}`);
}

await main();
