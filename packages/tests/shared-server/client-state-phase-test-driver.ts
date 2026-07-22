import { Temporal } from '@js-temporal/polyfill';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ClientPlatform } from '@shared/api/client-types.ts';
import type {
    ConnectClientSessionRequest,
    DisconnectClientSessionRequest,
    HeartbeatClientSessionRequest,
    StateScope,
    UpsertClientInstanceRequest,
    UpsertClientPrincipalRequest,
} from '@shared/api/state-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import {
    type ClientStateService,
    type ClientStateWritten,
    createClientStateService,
    requiresClientWrite,
    toClientMutationCommand,
    toClientMutationIssuedSessionAuthority,
    toClientMutationSystemAuthority,
    toClientStateWritten,
    toConnectCommandInput,
    toDisconnectCommandInput,
    toExpiryCommandInput,
    toHeartbeatCommandInput,
    toUpsertInstanceCommandInput,
    toUpsertPrincipalCommandInput,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/services/timing.ts';
import { defaultClientStateEventStoreFor } from '@shared-server/rallar-system/repositories/StateEventStore.ts';
import {
    AuthSessionRepository,
    type IssuedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';

const OUTBOX_BY_RUNTIME = new WeakMap<object, Map<string, ResourceEntry>>();
const OUTBOX_FAILURES_BY_RUNTIME = new WeakMap<object, number>();
const TEST_AUTH_ISSUED_AT_EPOCH_MS = 0;
const TEST_AUTH_EXPIRES_AT_EPOCH_MS = 253_402_300_799_000;

export type ClientStatePhaseTestDriver = Pick<
    ClientStateService,
    'listSnapshots' | 'readSnapshot' | 'readPresenceSnapshot' | 'listEvents' | 'listEventPage'
> &
    Readonly<{
        upsertPrincipal(
            scope: StateScope,
            principalId: string,
            request: UpsertClientPrincipalRequest,
        ): Promise<ClientStateWritten>;
        upsertInstance(
            scope: StateScope,
            principalId: string,
            clientInstanceId: string,
            request: UpsertClientInstanceRequest,
        ): Promise<ClientStateWritten>;
        connectSession(
            scope: StateScope,
            principalId: string,
            clientInstanceId: string,
            sessionId: string,
            request: ConnectClientSessionRequest,
        ): Promise<ClientStateWritten>;
        heartbeatSession(
            scope: StateScope,
            principalId: string,
            clientInstanceId: string,
            sessionId: string,
            request: HeartbeatClientSessionRequest,
        ): Promise<ClientStateWritten>;
        disconnectSession(
            scope: StateScope,
            principalId: string,
            clientInstanceId: string,
            sessionId: string,
            request: DisconnectClientSessionRequest,
        ): Promise<ClientStateWritten>;
        expireExpiredSessions(atEpochMs: number): Promise<readonly ClientStateWritten[]>;
        registerAuthorisedWsClientSession(
            authSession: AuthSession,
            generationId: string,
            input?: Readonly<{
                applicationId?: string;
                workspaceId?: string;
                principalId?: string;
                clientInstanceId?: string;
                connectedAtEpochMs?: number;
                expiresAtEpochMs?: number;
                userAgent?: string;
                platform?: ClientPlatform;
                capabilities?: readonly string[];
                displayName?: string;
            }>,
        ): Promise<ClientStateWritten>;
        disconnectAuthorisedWsClientSession(
            sessionId: string,
            generationId: string,
            reason?: string,
        ): Promise<ClientStateWritten>;
    }>;

export function createClientStatePhaseTestDriver(
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike,
    nowEpochMs: () => number,
    options: Readonly<{
        serviceId?: string;
        timing?: RallarTimingSink;
    }> = {},
): ClientStatePhaseTestDriver {
    const outbox = outboxFor(runtimeRepository);
    const eventStore = defaultClientStateEventStoreFor(runtimeRepository);
    const authSessions = new AuthSessionRepository(runtimeRepository);
    const service = createClientStateService({
        runtimeRepository,
        createClientStateEventStore: () => eventStore,
        serviceId: options.serviceId ?? 'client-service',
        timing: options.timing,
    });
    let commandSequence = 0;

    const execute = async (
        inputFactory: () => Parameters<typeof toClientMutationCommand>[0],
    ): Promise<ClientStateWritten> => {
        for (let attempt = 1; attempt <= 8; attempt += 1) {
            const input = inputFactory();
            const now = nowEpochMs();
            const retentionExpiresAtEpochMs = TEST_AUTH_EXPIRES_AT_EPOCH_MS;
            const authority = await toTestAuthority(input);
            const command = await toClientMutationCommand(
                input,
                {
                    nowEpochMs: now,
                    serviceId: options.serviceId ?? 'client-service',
                    eventId: `test-client-event:${input.commandId}:${++commandSequence}`,
                    attemptCount: attempt,
                    expireAtEpochMs: retentionExpiresAtEpochMs,
                },
                authority,
            );
            const read = await service.read(command);
            const computed = service.compute(command, read);
            service.validate(command, read, computed);
            try {
                if (requiresClientWrite(computed)) {
                    await runtimeRepository.begin(async (runtime) => {
                        const before = new Map(outbox);
                        const eventsBefore = [...eventStore.events];
                        try {
                            await service.write(
                                toClientTransaction(
                                    outbox,
                                    runtime,
                                    runtimeRepository,
                                    eventStore,
                                ),
                                computed,
                            );
                        } catch (error) {
                            outbox.clear();
                            for (const [key, entry] of before) outbox.set(key, entry);
                            eventStore.events.length = 0;
                            eventStore.events.push(...eventsBefore);
                            throw error;
                        }
                    });
                }
                if (computed.outcome === 'idempotency-conflict') {
                    throw new Error('Validated idempotency conflict is unreachable');
                }
                return toClientStateWritten(computed);
            } catch (error) {
                if (error instanceof RuntimeStateWriteConflictError && attempt < 8) continue;
                throw error;
            }
        }
        throw new Error('Client test driver retry loop exhausted');
    };

    return {
        listSnapshots: service.listSnapshots,
        readSnapshot: service.readSnapshot,
        readPresenceSnapshot: service.readPresenceSnapshot,
        listEvents: service.listEvents,
        listEventPage: service.listEventPage,
        upsertPrincipal: async (scope, principalId, request) =>
            await execute(() =>
                toUpsertPrincipalCommandInput(scope, principalId, request, nextId()),
            ),
        upsertInstance: async (scope, principalId, clientInstanceId, request) =>
            await execute(() =>
                toUpsertInstanceCommandInput(
                    scope,
                    principalId,
                    clientInstanceId,
                    request,
                    nextId(),
                ),
            ),
        connectSession: async (scope, principalId, clientInstanceId, sessionId, request) =>
            await execute(() =>
                toConnectCommandInput(
                    'connectSession',
                    scope,
                    principalId,
                    clientInstanceId,
                    sessionId,
                    request,
                    nextId(),
                    {},
                ),
            ),
        heartbeatSession: async (scope, principalId, clientInstanceId, sessionId, request) =>
            await execute(() =>
                toHeartbeatCommandInput(
                    scope,
                    principalId,
                    clientInstanceId,
                    sessionId,
                    request,
                    nextId(),
                ),
            ),
        disconnectSession: async (scope, principalId, clientInstanceId, sessionId, request) =>
            await execute(() =>
                toDisconnectCommandInput(
                    'disconnectSession',
                    scope,
                    principalId,
                    clientInstanceId,
                    sessionId,
                    request,
                    nextId(),
                ),
            ),
        expireExpiredSessions: async (atEpochMs) => {
            const candidates = await service.listExpiredSessionCandidates(atEpochMs);
            return await Promise.all(
                candidates.map(
                    async (candidate) => await execute(() => toExpiryCommandInput(candidate)),
                ),
            );
        },
        registerAuthorisedWsClientSession: async (auth, generationId, input = {}) => {
            const scope = {
                applicationId: input.applicationId ?? 'rallar-server',
                workspaceId: input.workspaceId ?? 'default',
            };
            const principalId = input.principalId ?? auth.clientId;
            return await execute(() =>
                toConnectCommandInput(
                    'connectAuthorisedWsSession',
                    scope,
                    principalId,
                    input.clientInstanceId ?? auth.clientId,
                    auth.sessionId,
                    {
                        generationId,
                        transport: 'ws',
                        connectionId: generationId,
                        connectedAtEpochMs: input.connectedAtEpochMs,
                        expiresAtEpochMs: input.expiresAtEpochMs ?? auth.expiresAtEpochMs,
                        actorPrincipalId: principalId,
                        actorSessionId: auth.sessionId,
                        requestId: `authorised-ws:connect:${auth.sessionId}:${generationId}`,
                    },
                    nextId(),
                    {
                        platform: input.platform,
                        userAgent: input.userAgent,
                        capabilities: input.capabilities,
                        principalUsername: auth.username,
                        principalDisplayName: input.displayName ?? auth.username,
                        principalRoles: ['member'],
                    },
                ),
            );
        },
        disconnectAuthorisedWsClientSession: async (sessionId, generationId, reason) => {
            const session = await service.findSessionBySessionId(sessionId);
            if (!session)
                throw new Error(`Durable client connection generation not found: ${sessionId}`);
            return await execute(() =>
                toDisconnectCommandInput(
                    'disconnectAuthorisedWsSession',
                    {
                        applicationId: session.applicationId,
                        workspaceId: session.workspaceId,
                    },
                    session.principalId,
                    session.clientInstanceId,
                    sessionId,
                    {
                        generationId,
                        reason,
                        actorPrincipalId: session.principalId,
                        actorSessionId: sessionId,
                        requestId: `authorised-ws:disconnect:${sessionId}:${generationId}`,
                    },
                    nextId(),
                ),
            );
        },
    };

    function nextId(): string {
        return `test-client-command-${++commandSequence}`;
    }

    async function toTestAuthority(
        input: Parameters<typeof toClientMutationCommand>[0],
    ) {
        if (input.operation === 'expireSession') {
            return toClientMutationSystemAuthority(
                options.serviceId ?? 'client-service',
            );
        }
        const sessionId = 'sessionId' in input
            ? input.sessionId
            : input.input.actorSessionId ??
                `${input.aggregateRef.principalId}-test-authority-session`;
        const existing = await authSessions.findBySessionId(sessionId);
        if (existing) {
            return toClientMutationIssuedSessionAuthority(
                existing,
                input.aggregateRef,
                input.operation,
            );
        }
        const session: IssuedAuthSession = {
            clientId: input.aggregateRef.principalId,
            accessToken: `${sessionId}-test-token`,
            username: input.aggregateRef.principalId,
            sessionId,
            issuedAtEpochMs: TEST_AUTH_ISSUED_AT_EPOCH_MS,
            expiresAtEpochMs: TEST_AUTH_EXPIRES_AT_EPOCH_MS,
        };
        await authSessions.putSession(session);
        return toClientMutationIssuedSessionAuthority(
            session,
            input.aggregateRef,
            input.operation,
        );
    }
}

export function createLegacyClientStateTestDriver(
    dependencies: Readonly<{
        runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
        now?: () => number;
        serviceId: string;
        timing?: RallarTimingSink;
        syncPublisher?: unknown;
        authSessionRepository?: unknown;
        randomId?: unknown;
        sleep?: unknown;
    }>,
): ClientStatePhaseTestDriver {
    return createClientStatePhaseTestDriver(
        dependencies.runtimeRepository,
        dependencies.now ?? Date.now,
        {
            serviceId: dependencies.serviceId,
            timing: dependencies.timing,
        },
    );
}

export function getClientStateTestOutbox(
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike,
): readonly ResourceEntry[] {
    return [...outboxFor(runtimeRepository).values()];
}

export function failNextClientStateTestOutboxWrite(
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike,
): void {
    const identity = runtimeRepository as object;
    OUTBOX_FAILURES_BY_RUNTIME.set(identity, (OUTBOX_FAILURES_BY_RUNTIME.get(identity) ?? 0) + 1);
}

function outboxFor(
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike,
): Map<string, ResourceEntry> {
    const identity = runtimeRepository as object;
    let entries = OUTBOX_BY_RUNTIME.get(identity);
    if (!entries) {
        entries = new Map();
        OUTBOX_BY_RUNTIME.set(identity, entries);
    }
    return entries;
}

function toClientTransaction(
    outbox: Map<string, ResourceEntry>,
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike,
    eventStore: ReturnType<typeof defaultClientStateEventStoreFor>,
): PSqlTransactionSql {
    const transaction = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join('?').replace(/\s+/gu, ' ').trim().toLowerCase();
        if (
            query.includes('insert into runtime_state_store') &&
            query.includes('do nothing') &&
            query.includes('returning revision')
        ) {
            const [namespace, key, value, expireAt] = values as [
                string,
                string,
                string,
                Date,
            ];
            const result = await runtime.insertIfAbsent(
                namespace,
                key,
                value,
                expireAt.getTime(),
            );
            return result.status === 'applied' ? [{ revision: result.revision }] : [];
        }
        if (
            query.includes('update runtime_state_store') &&
            query.includes('returning revision')
        ) {
            const [value, expireAt, namespace, key, expectedRevision] = values as [
                string,
                Date,
                string,
                string,
                number,
            ];
            const result = await runtime.upsertIfRevision(
                namespace,
                key,
                value,
                expireAt.getTime(),
                expectedRevision,
            );
            return result.status === 'applied' ? [{ revision: result.revision }] : [];
        }
        if (query.includes('insert into client_state_events')) {
            const eventJson = values.at(-1);
            if (typeof eventJson !== 'string') {
                throw new Error('Client state event JSON is required');
            }
            const event = JSON.parse(eventJson) as ClientEvent;
            await eventStore.appendClientEvent(event);
            return [{ event_id: event.eventId }];
        }
        if (query.includes('insert into resource_inbox')) {
            const entry = toEntry(values);
            const identity = runtimeRepository as object;
            const failures = OUTBOX_FAILURES_BY_RUNTIME.get(identity) ?? 0;
            if (failures > 0) {
                OUTBOX_FAILURES_BY_RUNTIME.set(identity, failures - 1);
                throw new ResourceInboxInvariantCorruptionError(
                    entry.key,
                    'Injected client test outbox collision',
                );
            }
            const key = toKey(entry);
            if (outbox.has(key)) return [];
            outbox.set(key, entry);
            return [toRow(entry)];
        }
        if (query.includes('from resource_inbox')) {
            const [topicId, resourceId, contextId] = values as string[];
            const entry = outbox.get(`${contextId}:${topicId}:${resourceId}`);
            return entry ? [toRow(entry)] : [];
        }
        throw new Error(`Unexpected client test transaction SQL: ${query}`);
    }) as unknown as PSqlTransactionSql;
    transaction.begin = async () => {
        throw new Error('Nested client test transaction');
    };
    return transaction;
}

function toEntry(values: readonly unknown[]): ResourceEntry {
    const [
        resourceId,
        topicId,
        resource,
        typeId,
        status,
        contextId,
        systemDate,
        createdBy,
        createdTs,
        expiryTs,
        startTs,
        endTs,
        nextTs,
        attempts,
    ] = values;
    return {
        key: { resourceId, topicId, contextId } as ResourceEntry['key'],
        resource: resource as string,
        typeId: typeId as string,
        status: status as ResourceEntry['status'],
        audit: {
            date: Temporal.PlainDate.from(systemDate as string)
                .toPlainDateTime()
                .toPlainTime(),
            createdBy: createdBy as string,
            createdTs: Temporal.PlainDateTime.from(String(createdTs).replace(/Z$/u, '')),
            expiryTs: toInstant(expiryTs),
        },
        dequeueAudit: {
            startTs: startTs === null ? undefined : toInstant(startTs),
            endTs: endTs === null ? undefined : toInstant(endTs),
            nextTs: nextTs === null ? undefined : toInstant(nextTs),
            attempts: Number(attempts),
        },
    };
}

function toInstant(value: unknown): Temporal.Instant {
    const text = String(value);
    return Temporal.Instant.from(text.endsWith('Z') ? text : `${text}Z`);
}

function toKey(entry: ResourceEntry): string {
    return `${entry.key.contextId}:${entry.key.topicId}:${entry.key.resourceId}`;
}

function toRow(entry: ResourceEntry) {
    return {
        ri_row_id: 1n,
        ri_resource_id: entry.key.resourceId,
        ri_topic_id: entry.key.topicId,
        ri_resource: entry.resource,
        ri_type_id: entry.typeId,
        ri_status: entry.status,
        fk_ext_bank_id: entry.key.contextId,
        system_date: entry.audit.createdTs.toPlainDate().toString(),
        created_by: entry.audit.createdBy,
        created_ts: entry.audit.createdTs.toString(),
        expire_ts: entry.audit.expiryTs.toZonedDateTimeISO('UTC').toPlainDateTime().toString(),
        start_ts: entry.dequeueAudit.startTs?.toString() ?? null,
        end_ts: entry.dequeueAudit.endTs?.toString() ?? null,
        next_ts: entry.dequeueAudit.nextTs?.toString() ?? null,
        ri_attempts: BigInt(entry.dequeueAudit.attempts),
    };
}
