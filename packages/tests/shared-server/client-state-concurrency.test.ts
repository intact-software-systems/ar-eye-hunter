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
    ClientMutationRejectedError,
    validateClientMutationCommand,
    validateClientMutation,
} from '@shared-server/rallar-system/services/client-state-mutations.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import type {
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import {
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
} from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
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

    it('exhausts exactly three principal guards with delays 2 and 8 and no partial writes', async () => {
        const runtime = new AlwaysConflictingPrincipalRepository();
        const delays: number[] = [];
        const timing: RallarTimingEvent[] = [];
        const service = createClientStateService({
            runtimeRepository: runtime,
            syncPublisher: createPublisher(),
            now: () => 1_000,
            randomId: () => 'event-conflict',
            sleep: (delayMs) => {
                delays.push(delayMs);
                return Promise.resolve();
            },
            serviceId: 'client-service',
            timing: (event) => timing.push(event),
        });

        const error = await service.upsertInstance(SCOPE, 'alice', 'browser', {
            platform: 'web',
            requestId: 'three-conflicts',
        }).catch((caught) => caught);

        expect(error).toBeInstanceOf(RuntimeStateRetryExhaustedError);
        expect(error.cause).toBeInstanceOf(RuntimeStateWriteConflictError);
        expect(error.attempts).toBe(3);
        expect(delays).toEqual([2, 8]);
        expect(runtime.principalGuardCount).toBe(3);
        expect(runtime.transactionBeginCount).toBe(3);
        expect(runtime.data.size).toBe(0);
        expect(timing.filter((event) => event.operation === 'mutation.conflict'))
            .toMatchObject([
                { details: { attempt: 0, backoffMs: 0, conflict: true } },
                { details: { attempt: 1, backoffMs: 2, conflict: true } },
                { details: { attempt: 2, backoffMs: 8, conflict: true } },
            ]);
    });

    it('opens no transaction for replay or no-op and guards the principal first for a write', async () => {
        const runtime = new StatementRecordingRepository();
        const service = createClientStateService({
            runtimeRepository: runtime,
            syncPublisher: createPublisher(),
            now: () => 1_000,
            randomId: () => 'event-order',
            sleep: () => Promise.resolve(),
            serviceId: 'client-service',
        });
        await service.upsertPrincipal(SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Alice',
            requestId: 'guard-first',
        });
        expect(runtime.transactionStatements[0]).toBe(
            'insertIfAbsent:client-state:principals',
        );

        runtime.resetInstrumentation();
        await service.upsertPrincipal(SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Alice',
            requestId: 'guard-first',
        });
        expect(runtime.transactionBeginCount).toBe(0);
        expect(runtime.transactionStatements).toEqual([]);

        await service.upsertPrincipal(SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Alice',
            requestId: 'semantic-no-op',
        });
        expect(runtime.transactionBeginCount).toBe(0);
        expect(runtime.transactionStatements).toEqual([]);
    });

    it('requires generation identity and exposes no caller command hash', () => {
        expectTypeOf<ConnectClientSessionRequest>().toHaveProperty('generationId');
        expectTypeOf<ConnectClientSessionRequest>().not.toHaveProperty('commandHash');
        expectTypeOf<ClientSession>().toHaveProperty('generationVersion');
    });

    it('rejects malformed authoritative command shapes for every client branch before compute or hash', () => {
        const base = {
            aggregateRef: principalRef('alice'),
            commandId: 'command-1',
            requestId: 'command-1',
        } as const;
        const actor = {
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null,
        } as const;
        const invalidCommands: readonly unknown[] = [
            [],
            {
                ...base,
                operation: 'upsertPrincipal',
                input: {
                    ...actor,
                    username: '',
                    displayName: null,
                    avatarUrl: null,
                    status: 'impossible',
                    authProvider: null,
                    externalSubjectId: null,
                    roles: [],
                    metadata: {},
                    lastSeenAtEpochMs: null,
                },
            },
            {
                ...base,
                operation: 'upsertInstance',
                clientInstanceId: '',
                input: {
                    ...actor,
                    status: null,
                    platform: 'browser',
                    deviceLabel: null,
                    appVersion: null,
                    userAgent: null,
                    capabilities: [],
                },
            },
            invalidSessionCommand(base, actor, 'connectSession', {
                generationId: { forged: true },
            }),
            invalidSessionCommand(base, actor, 'connectAuthorisedWsSession', {
                transport: 'carrier-pigeon',
            }),
            invalidSessionCommand(base, actor, 'heartbeatSession', {
                lastHeartbeatAtEpochMs: -1,
            }),
            invalidSessionCommand(base, actor, 'disconnectSession', {
                actorPrincipalId: 42,
            }),
            invalidSessionCommand(base, actor, 'disconnectAuthorisedWsSession', {
                reason: { nested: 'not-a-string' },
            }),
            invalidSessionCommand(base, actor, 'expireSession', {
                generationVersion: 0,
                observedExpiresAtEpochMs: Number.NaN,
            }),
        ];

        for (const command of invalidCommands) {
            expect(() => validateClientMutationCommand(command)).toThrow(
                ClientMutationRejectedError,
            );
        }
    });

    it('rejects causally impossible lifecycle timestamps in commands, stored reads, and computed state', async () => {
        const base = {
            aggregateRef: principalRef('alice'),
            commandId: 'causal-command',
            requestId: 'causal-command',
        } as const;
        const actor = {
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null,
        } as const;
        const invalidCommands = [
            invalidSessionCommand(base, actor, 'connectSession', {
                authenticatedAtEpochMs: 1_001,
                connectedAtEpochMs: 1_000,
            }),
            invalidSessionCommand(base, actor, 'connectSession', {
                connectedAtEpochMs: 1_001,
                lastHeartbeatAtEpochMs: 1_000,
            }),
            invalidSessionCommand(base, actor, 'heartbeatSession', {
                lastHeartbeatAtEpochMs: 2_001,
                expiresAtEpochMs: 2_000,
            }),
            invalidSessionCommand(base, actor, 'disconnectSession', {
                disconnectedAtEpochMs: 999,
                lastHeartbeatAtEpochMs: 1_000,
            }),
            invalidSessionCommand(base, actor, 'expireSession', {
                observedExpiresAtEpochMs: 2_001,
                expiresAtEpochMs: 2_000,
            }),
        ];
        for (const command of invalidCommands) {
            const error = (() => {
                try {
                    validateClientMutationCommand(command);
                } catch (caught) {
                    return caught;
                }
            })();
            expect(error).toMatchObject({
                code: 'client-mutation-rejected',
                status: 400,
            });
        }

        const validConnect = invalidSessionCommand(
            { ...base, commandId: 'valid-connect', requestId: 'valid-connect' },
            actor,
            'connectSession',
            {},
        ) as ClientMutationCommand;
        const computed = computeClientMutation({
            command: validConnect,
            read: { idempotency: null, principal: null, instance: null, session: null },
            facts: validFacts(),
        });
        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write' || computed.session.operation === 'none') {
            throw new Error('Expected a session write');
        }
        const corruptSession = {
            ...computed.session.value,
            expiresAtEpochMs: computed.session.value.lastHeartbeatAtEpochMs - 1,
        };
        const entry = (value: unknown) => ({
            entry: {
                key: 'stored',
                value: JSON.stringify(value),
                expireAtTimestamp: 10_000,
                updatedTimestamp: '2026-07-19T00:00:00.000Z',
                revision: 0,
            },
            value,
        });
        expect(() => computeClientMutation({
            command: invalidSessionCommand(
                { ...base, commandId: 'heartbeat-corrupt', requestId: 'heartbeat-corrupt' },
                actor,
                'heartbeatSession',
                {},
            ) as ClientMutationCommand,
            read: {
                idempotency: null,
                principal: entry(computed.principal.value) as never,
                instance: computed.instance.operation === 'none'
                    ? null
                    : entry(computed.instance.value) as never,
                session: entry(corruptSession) as never,
            },
            facts: validFacts(),
        })).toThrow(ClientMutationRejectedError);

        const invalidComputed = structuredClone(computed);
        if (invalidComputed.outcome !== 'write' ||
            invalidComputed.session.operation === 'none') {
            throw new Error('Expected a session write');
        }
        invalidComputed.session.value.expiresAtEpochMs =
            invalidComputed.session.value.lastHeartbeatAtEpochMs - 1;
        expect(() => validateClientMutation({
            command: validConnect,
            read: { idempotency: null, principal: null, instance: null, session: null },
            computed: invalidComputed,
            facts: validFacts(),
        })).toThrow(ClientMutationRejectedError);

        const runtime = new AggregateBarrierRepository();
        await expect(createService(runtime, 1_000).heartbeatSession(
            SCOPE,
            'alice',
            'browser',
            'session-1',
            {
                generationId: 'generation-1',
                lastHeartbeatAtEpochMs: 2_001,
                expiresAtEpochMs: 2_000,
                requestId: 'malformed-heartbeat',
            },
        )).rejects.toMatchObject({ status: 400 });
        expect(runtime.data.size).toBe(0);

        await connect(runtime, 'corrupt-session', 'corrupt-generation', BASE_EPOCH_MS);
        const storedSession = [...runtime.data.entries()].find(([, stored]) => {
            try {
                return JSON.parse(stored.value).generationId === 'corrupt-generation';
            } catch {
                return false;
            }
        });
        if (!storedSession) throw new Error('Expected stored client session');
        const corruptValue = JSON.parse(storedSession[1].value);
        corruptValue.expiresAtEpochMs = corruptValue.lastHeartbeatAtEpochMs - 1;
        runtime.data.set(storedSession[0], {
            ...storedSession[1],
            value: JSON.stringify(corruptValue),
        });
        const corruptBefore = structuredClone([...runtime.data.entries()]);
        await expect(createService(runtime, BASE_EPOCH_MS + 1_000).heartbeatSession(
            SCOPE,
            'alice',
            'browser',
            'corrupt-session',
            {
                generationId: 'corrupt-generation',
                lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 1_000,
                expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
                requestId: 'reject-corrupt-stored-session',
            },
        )).rejects.toMatchObject({ status: 400 });
        expect([...runtime.data.entries()]).toEqual(corruptBefore);
    });

    it('rejects malformed read entries and computed authoritative candidates', () => {
        const command = validPrincipalCommand();
        const facts = validFacts();
        expect(() => computeClientMutation({
            command,
            read: [] as unknown as ClientMutationRead,
            facts,
        })).toThrow(ClientMutationRejectedError);

        const invalidRead = {
            idempotency: null,
            principal: {
                entry: {
                    key: 'principal',
                    value: '{}',
                    expireAtTimestamp: 1_000,
                    updatedTimestamp: 'now',
                    revision: -1,
                },
                value: {
                    ...validPrincipalValue(),
                    snapshotVersion: Number.POSITIVE_INFINITY,
                },
            },
            instance: null,
            session: null,
        } as unknown as ClientMutationRead;
        expect(() => computeClientMutation({ command, read: invalidRead, facts }))
            .toThrow(ClientMutationRejectedError);

        const read: ClientMutationRead = {
            idempotency: null,
            principal: null,
            instance: null,
            session: null,
        };
        const computed = computeClientMutation({ command, read, facts });
        const invalidComputed = structuredClone(computed) as Record<string, unknown>;
        (invalidComputed.receipt as Record<string, unknown>).snapshotVersion = -1;
        expect(() => validateClientMutation({
            command,
            read,
            facts,
            computed: invalidComputed as unknown as typeof computed,
        })).toThrow(ClientMutationRejectedError);
    });
});

function invalidSessionCommand(
    base: Readonly<Record<string, unknown>>,
    actor: Readonly<Record<string, unknown>>,
    operation: string,
    override: Readonly<Record<string, unknown>>,
): unknown {
    const common = {
        ...base,
        operation,
        clientInstanceId: 'browser',
        sessionId: 'session-1',
    };
    const operationInput = operation === 'expireSession'
        ? {
            ...actor,
            generationId: 'generation-1',
            generationVersion: 1,
            observedExpiresAtEpochMs: 2_000,
            expiresAtEpochMs: 2_000,
        }
        : operation.includes('connect')
        ? {
            ...actor,
            generationId: 'generation-1',
            presenceState: 'online',
            transport: 'ws',
            connectionId: 'generation-1',
            authenticatedAtEpochMs: 1_000,
            connectedAtEpochMs: 1_000,
            lastHeartbeatAtEpochMs: 1_000,
            expiresAtEpochMs: 2_000,
            instancePlatform: 'web',
            instanceUserAgent: null,
            instanceCapabilities: [],
            principalUsername: null,
            principalDisplayName: null,
            principalRoles: null,
        }
        : operation.includes('heartbeat')
        ? {
            ...actor,
            generationId: 'generation-1',
            presenceState: 'online',
            lastHeartbeatAtEpochMs: 1_000,
            expiresAtEpochMs: 2_000,
        }
        : {
            ...actor,
            generationId: 'generation-1',
            disconnectedAtEpochMs: 1_000,
            lastHeartbeatAtEpochMs: 1_000,
            expiresAtEpochMs: 2_000,
        };
    return { ...common, input: { ...operationInput, ...override } };
}

function validPrincipalCommand(): ClientMutationCommand {
    return {
        operation: 'upsertPrincipal',
        aggregateRef: principalRef('alice'),
        commandId: 'valid-command',
        requestId: 'valid-command',
        input: {
            username: 'alice',
            displayName: 'Alice',
            avatarUrl: null,
            status: 'active',
            authProvider: null,
            externalSubjectId: null,
            roles: [],
            metadata: {},
            lastSeenAtEpochMs: 1_000,
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null,
        },
    };
}

function validFacts(): ClientMutationFacts {
    return {
        nowEpochMs: 1_000,
        serviceId: 'client-service',
        eventId: 'event-1',
        commandHash: `sha256:${'a'.repeat(64)}`,
    };
}

function validPrincipalValue() {
    const audit = {
        atEpochMs: 1_000,
        byPrincipalId: 'alice',
        byServiceId: 'client-service',
    };
    return {
        ...principalRef('alice'),
        username: 'alice',
        status: 'active' as const,
        roles: [],
        metadata: {},
        snapshotVersion: 1,
        profileVersion: 1,
        presenceVersion: 1,
        created: audit,
        updated: audit,
    };
}

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

class AlwaysConflictingPrincipalRepository extends AggregateBarrierRepository {
    principalGuardCount = 0;
    transactionBeginCount = 0;

    override async begin<T>(
        fn: (repository: RuntimeStateOptimisticTransactionalRepositoryLike) => Promise<T>,
    ): Promise<T> {
        this.transactionBeginCount += 1;
        return await super.begin(fn);
    }

    override insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        if (namespace === 'client-state:principals') {
            this.principalGuardCount += 1;
            return Promise.resolve({ status: 'conflict' });
        }
        return super.insertIfAbsent(namespace, key, value, expireAtTimestamp);
    }
}

class StatementRecordingRepository extends AggregateBarrierRepository {
    transactionBeginCount = 0;
    readonly transactionStatements: string[] = [];
    private transactionDepth = 0;

    override async begin<T>(
        fn: (repository: RuntimeStateOptimisticTransactionalRepositoryLike) => Promise<T>,
    ): Promise<T> {
        this.transactionBeginCount += 1;
        this.transactionDepth += 1;
        try {
            return await super.begin(fn);
        } finally {
            this.transactionDepth -= 1;
        }
    }

    override insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        this.record('insertIfAbsent', namespace);
        return super.insertIfAbsent(namespace, key, value, expireAtTimestamp);
    }

    override upsertIfRevision(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        this.record('upsertIfRevision', namespace);
        return super.upsertIfRevision(
            namespace,
            key,
            value,
            expireAtTimestamp,
            expectedRevision,
        );
    }

    resetInstrumentation(): void {
        this.transactionBeginCount = 0;
        this.transactionStatements.length = 0;
    }

    private record(operation: string, namespace: string): void {
        if (this.transactionDepth > 0) {
            this.transactionStatements.push(`${operation}:${namespace}`);
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
