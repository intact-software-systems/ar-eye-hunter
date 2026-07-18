import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type {
    ClientPrincipalRef,
    ClientSession,
} from '@shared/api/client-types.ts';
import type {
    ConnectClientSessionRequest,
    StateScope,
} from '@shared/api/state-types.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { STATE_MUTATION_OUTBOX_NAMESPACE } from '@shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts';
import {
    ClientMutationIdempotencyConflictError,
    createClientStateService,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import {
    computeClientMutation,
    type ClientMutationCommand,
    type ClientMutationFacts,
    type ClientMutationRead,
    validateClientMutation,
} from '@shared-server/rallar-system/services/client-state-mutations.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

const SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
};
const BASE_EPOCH_MS = Date.now();

describe('convergent client state', () => {
    it('keeps principal profile and instance registration across an aggregate CAS race', async () => {
        const runtime = new AggregateBarrierRepository();
        const seed = createService(runtime, 1_000);
        await seed.upsertPrincipal(SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Before',
            requestId: 'seed-principal',
        });
        const before = await snapshot(runtime, 'alice');
        runtime.armPrincipalReadBarrier(2);

        const [profile, instance] = await Promise.all([
            createService(runtime, 2_000).upsertPrincipal(SCOPE, 'alice', {
                username: 'alice',
                displayName: 'After',
                metadata: { theme: 'dark' },
                requestId: 'profile-race',
            }),
            createService(runtime, 2_001).upsertInstance(
                SCOPE,
                'alice',
                'browser',
                {
                    platform: 'web',
                    deviceLabel: 'Laptop',
                    requestId: 'instance-race',
                },
            ),
        ]);

        expect(profile.result.right?.event?.eventType).toBe('principal-updated');
        expect(instance.result.right?.event?.eventType).toBe('instance-registered');
        const after = await snapshot(runtime, 'alice');
        expect(after.principal).toMatchObject({
            displayName: 'After',
            metadata: { theme: 'dark' },
        });
        expect(after.instances).toEqual([
            expect.objectContaining({ clientInstanceId: 'browser', deviceLabel: 'Laptop' }),
        ]);
        expect(after.stateRevision).toBe(before.stateRevision + 2);
        expect(await outboxFor(runtime, ['profile-race', 'instance-race'])).toHaveLength(2);
    });

    it('rebases independent heartbeats and makes disconnect terminal for its generation', async () => {
        const runtime = new AggregateBarrierRepository();
        await connect(runtime, 'session-a', 'generation-a', BASE_EPOCH_MS);
        await connect(runtime, 'session-b', 'generation-b', BASE_EPOCH_MS + 100);
        const before = await snapshot(runtime, 'alice');
        runtime.armPrincipalReadBarrier(2);

        await Promise.all([
            createService(runtime, BASE_EPOCH_MS + 1_000).heartbeatSession(
                SCOPE,
                'alice',
                'browser',
                'session-a',
                {
                    generationId: 'generation-a',
                    presenceState: 'away',
                    lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 1_000,
                    expiresAtEpochMs: BASE_EPOCH_MS + 20_000,
                    requestId: 'heartbeat-a',
                },
            ),
            createService(runtime, BASE_EPOCH_MS + 1_001).heartbeatSession(
                SCOPE,
                'alice',
                'browser',
                'session-b',
                {
                    generationId: 'generation-b',
                    presenceState: 'busy',
                    lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 1_001,
                    expiresAtEpochMs: BASE_EPOCH_MS + 20_001,
                    requestId: 'heartbeat-b',
                },
            ),
        ]);

        const afterHeartbeats = await snapshot(runtime, 'alice');
        expect(afterHeartbeats.stateRevision).toBe(before.stateRevision + 2);
        expect(afterHeartbeats.activeSessions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ sessionId: 'session-a', presenceState: 'away' }),
                expect.objectContaining({ sessionId: 'session-b', presenceState: 'busy' }),
            ]),
        );

        runtime.armPrincipalReadBarrier(2);
        await Promise.all([
            createService(runtime, BASE_EPOCH_MS + 2_000).heartbeatSession(
                SCOPE,
                'alice',
                'browser',
                'session-a',
                {
                    generationId: 'generation-a',
                    lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 2_000,
                    expiresAtEpochMs: BASE_EPOCH_MS + 30_000,
                    requestId: 'heartbeat-before-disconnect',
                },
            ),
            createService(runtime, BASE_EPOCH_MS + 2_001).disconnectSession(
                SCOPE,
                'alice',
                'browser',
                'session-a',
                {
                    generationId: 'generation-a',
                    disconnectedAtEpochMs: BASE_EPOCH_MS + 2_001,
                    requestId: 'disconnect-terminal',
                },
            ),
        ]);

        const stored = await new ClientStateRepository(runtime).findSession({
            ...principalRef('alice'),
            clientInstanceId: 'browser',
            sessionId: 'session-a',
        });
        expect(stored).toMatchObject({
            status: 'disconnected',
            generationId: 'generation-a',
            generationVersion: 1,
        });
        expect(
            (await new ClientStateRepository(runtime).listEvents(principalRef('alice')))
                .filter((event) => event.requestId === 'disconnect-terminal'),
        ).toHaveLength(1);
        expect(runtime.locks).toEqual([]);
    });

    it('keeps a reconnect when stale expiry races the reused session id', async () => {
        const runtime = new AggregateBarrierRepository();
        await connect(
            runtime,
            'session-a',
            'generation-1',
            BASE_EPOCH_MS,
            BASE_EPOCH_MS + 500,
        );
        runtime.armPrincipalReadBarrier(2);

        const [, reconnect] = await Promise.all([
            createService(runtime, BASE_EPOCH_MS + 1_000)
                .expireExpiredSessions(BASE_EPOCH_MS + 1_000),
            createService(runtime, BASE_EPOCH_MS + 1_001).connectSession(
                SCOPE,
                'alice',
                'browser',
                'session-a',
                {
                    generationId: 'generation-2',
                    connectionId: 'connection-2',
                    connectedAtEpochMs: BASE_EPOCH_MS + 1_001,
                    lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 1_001,
                    expiresAtEpochMs: BASE_EPOCH_MS + 20_000,
                    requestId: 'reconnect-generation-2',
                },
            ),
        ]);

        expect(reconnect.result.right?.event?.eventType).toBe('session-connected');
        const stored = await new ClientStateRepository(runtime).findSession({
            ...principalRef('alice'),
            clientInstanceId: 'browser',
            sessionId: 'session-a',
        });
        expect(stored).toMatchObject({
            status: 'active',
            generationId: 'generation-2',
            generationVersion: 2,
            connectionId: 'connection-2',
        });
        expect(
            (await new ClientStateRepository(runtime).listEvents(principalRef('alice')))
                .filter((event) => event.eventType === 'session-expired'),
        ).toHaveLength(1);
    });

    it('makes equal request races first-writer-wins and rejects different semantic content', async () => {
        const runtime = new AggregateBarrierRepository();
        const request = {
            username: 'alice',
            displayName: 'Alice',
            metadata: { one: 1, two: 2 },
            requestId: 'same-request',
        } as const;
        runtime.armPrincipalReadBarrier(2);
        const [first, second] = await Promise.all([
            createService(runtime, 1_000).upsertPrincipal(SCOPE, 'alice', request),
            createService(runtime, 9_000).upsertPrincipal(SCOPE, 'alice', {
                requestId: 'same-request',
                metadata: { two: 2, one: 1 },
                displayName: 'Alice',
                username: 'alice',
            }),
        ]);

        expect(second.result.right?.event).toEqual(first.result.right?.event);
        const idempotent = await new ClientStateRepository(runtime)
            .findIdempotentClientMutationReceipt(principalRef('alice'), 'same-request');
        expect(idempotent?.commandHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(idempotent?.receipt.commandHash).toBe(idempotent?.commandHash);
        const records = await outboxFor(runtime, ['same-request']);
        expect(records).toHaveLength(1);
        expect(records[0]?.commandHash).toBe(idempotent?.commandHash);

        const conflictRuntime = new AggregateBarrierRepository();
        conflictRuntime.armPrincipalReadBarrier(2);
        const results = await Promise.allSettled([
            createService(conflictRuntime, 1_000).upsertPrincipal(SCOPE, 'bob', {
                username: 'bob',
                displayName: 'First',
                requestId: 'different-content',
            }),
            createService(conflictRuntime, 1_001).upsertPrincipal(SCOPE, 'bob', {
                username: 'bob',
                displayName: 'Second',
                requestId: 'different-content',
            }),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected');
        expect(rejected).toMatchObject({
            reason: expect.any(ClientMutationIdempotencyConflictError),
        });
        expect(await outboxFor(conflictRuntime, ['different-content'])).toHaveLength(1);
    });

    it('commits a deterministic outbox intent without direct publication and survives a stop before drain', async () => {
        const runtime = new AggregateBarrierRepository();
        const publisher = createPublisher();
        const service = createService(runtime, 1_000, publisher);
        const written = await service.upsertPrincipal(SCOPE, 'alice', {
            username: 'alice',
            requestId: 'stop-after-commit',
        });

        expect(written.result.right?.event?.eventType).toBe('principal-created');
        expect(publisher.publishClientSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishClientEvent).not.toHaveBeenCalled();
        const persisted = await outboxFor(runtime, ['stop-after-commit']);
        expect(persisted).toEqual([
            expect.objectContaining({
                commandId: 'stop-after-commit',
                effects: ['client-state-sync'],
                delivery: { status: 'pending' },
            }),
        ]);
    });

    it('keeps pure compute and validation deterministic and side-effect free', () => {
        const command: ClientMutationCommand = deepFreeze({
            operation: 'upsertPrincipal',
            aggregateRef: principalRef('alice'),
            commandId: 'pure-command',
            requestId: 'pure-command',
            input: {
                username: 'alice',
                displayName: 'Alice',
                avatarUrl: null,
                status: null,
                authProvider: null,
                externalSubjectId: null,
                roles: [],
                metadata: {},
                lastSeenAtEpochMs: null,
                actorPrincipalId: null,
                actorSessionId: null,
                reason: null,
                traceId: null,
            },
        });
        const read: ClientMutationRead = deepFreeze({
            idempotency: null,
            principal: null,
            instance: null,
            session: null,
        });
        const facts: ClientMutationFacts = deepFreeze({
            nowEpochMs: 1_000,
            serviceId: 'client-service',
            eventId: 'event-1',
            commandHash: `sha256:${'a'.repeat(64)}`,
        });

        const first = computeClientMutation({ command, read, facts });
        const second = computeClientMutation({ command, read, facts });
        validateClientMutation({ command, read, computed: first, facts });
        validateClientMutation({ command, read, computed: second, facts });
        expect(second).toEqual(first);
        expect(command).toEqual(deepFreeze(structuredClone(command)));
        expect(read).toEqual(deepFreeze(structuredClone(read)));
    });

    it('requires generation identity and exposes no caller command hash', () => {
        expectTypeOf<ConnectClientSessionRequest>().toHaveProperty('generationId');
        expectTypeOf<ConnectClientSessionRequest>().not.toHaveProperty('commandHash');
        expectTypeOf<ClientSession>().toHaveProperty('generationVersion');
    });
});

class AggregateBarrierRepository extends FakeRuntimeStateRepository {
    private principalReadsRemaining = 0;
    private principalReadsArrived = 0;
    private releasePrincipalReads: (() => void) | undefined;
    private transactionTail: Promise<void> = Promise.resolve();

    armPrincipalReadBarrier(readers: number): void {
        this.principalReadsRemaining = readers;
        this.principalReadsArrived = 0;
    }

    override async findEntry(
        namespace: string,
        key: string,
    ): Promise<RuntimeStateEntry | undefined> {
        const value = await super.findEntry(namespace, key);
        if (namespace !== 'client-state:principals' || this.principalReadsRemaining <= 0) {
            return value;
        }
        this.principalReadsArrived += 1;
        if (this.principalReadsArrived === this.principalReadsRemaining) {
            this.releasePrincipalReads?.();
            this.principalReadsRemaining = 0;
            return value;
        }
        await new Promise<void>((resolve) => {
            this.releasePrincipalReads = resolve;
        });
        return value;
    }

    override async begin<T>(
        fn: (repository: RuntimeStateOptimisticTransactionalRepositoryLike) => Promise<T>,
    ): Promise<T> {
        let release!: () => void;
        const previous = this.transactionTail;
        this.transactionTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await super.begin(fn);
        } finally {
            release();
        }
    }
}

function createService(
    runtimeRepository: AggregateBarrierRepository,
    nowEpochMs: number,
    syncPublisher: StateSyncPublisher = createPublisher(),
) {
    return createClientStateService({
        runtimeRepository,
        syncPublisher,
        now: () => nowEpochMs,
        randomId: (() => {
            let next = 0;
            return () => `id-${nowEpochMs}-${++next}`;
        })(),
        sleep: () => Promise.resolve(),
        serviceId: 'client-service',
    });
}

async function connect(
    runtime: AggregateBarrierRepository,
    sessionId: string,
    generationId: string,
    nowEpochMs: number,
    expiresAtEpochMs = BASE_EPOCH_MS + 50_000,
): Promise<void> {
    await createService(runtime, nowEpochMs).connectSession(
        SCOPE,
        'alice',
        'browser',
        sessionId,
        {
            generationId,
            connectionId: generationId,
            connectedAtEpochMs: nowEpochMs,
            lastHeartbeatAtEpochMs: nowEpochMs,
            expiresAtEpochMs,
            requestId: `connect-${sessionId}-${generationId}`,
        },
    );
}

async function snapshot(runtime: AggregateBarrierRepository, principalId: string) {
    const value = await new ClientStateRepository(runtime).readSnapshot(
        principalRef(principalId),
    );
    if (!value) throw new Error(`missing snapshot for ${principalId}`);
    return value;
}

async function outboxFor(
    runtime: AggregateBarrierRepository,
    commandIds: readonly string[],
) {
    const records = await runtime.findAllEntries(STATE_MUTATION_OUTBOX_NAMESPACE);
    return records
        .map((entry) => JSON.parse(entry.value))
        .filter((record) => commandIds.includes(record.commandId));
}

function principalRef(principalId: string): ClientPrincipalRef {
    return { ...SCOPE, principalId };
}

function createPublisher(): StateSyncPublisher {
    return {
        publishClientSnapshot: vi.fn(() => Promise.resolve()),
        publishClientEvent: vi.fn(() => Promise.resolve()),
        publishGroupSnapshot: vi.fn(() => Promise.resolve()),
        publishGroupEvent: vi.fn(() => Promise.resolve()),
    };
}

function deepFreeze<T>(value: T): T {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
}
