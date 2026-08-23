import { type PersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-persistence-contracts.ts';
import type {
    ClientEvent,
    ClientInstance,
    ClientPlatform,
    ClientPresenceState,
    ClientPrincipal,
    ClientPrincipalRef,
    ClientPrincipalStatus,
    ClientSession,
    ClientSnapshot,
    ClientTransport
} from '@shared/api/client-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/RuntimeStateRepository.ts';
import type { ComputedClientStateSync } from '../../state-sync/state-sync-entry-computation.ts';
import type {
    ClientMutationIdempotencyRecord,
    ClientMutationReceipt
} from '../persistence/client-state-persistence-contracts.ts';

export type {
    ClientMutationIdempotencyRecord,
    ClientMutationReceipt
} from '../persistence/client-state-persistence-contracts.ts';

export type NullableActorInput = Readonly<{
    actorPrincipalId: string | null;
    actorSessionId: string | null;
    reason: string | null;
    traceId: string | null;
}>;

export type ClientMutationOperation =
    | 'upsertPrincipal'
    | 'upsertInstance'
    | 'connectSession'
    | 'connectAuthorisedWsSession'
    | 'heartbeatSession'
    | 'disconnectSession'
    | 'disconnectAuthorisedWsSession'
    | 'expireSession';

export const CLIENT_MUTATION_OPERATIONS = new Set<ClientMutationOperation>([
    'upsertPrincipal',
    'upsertInstance',
    'connectSession',
    'connectAuthorisedWsSession',
    'heartbeatSession',
    'disconnectSession',
    'disconnectAuthorisedWsSession',
    'expireSession'
]);
export const CLIENT_PRINCIPAL_STATUSES = new Set(['active', 'disabled', 'deleted']);
export const CLIENT_INSTANCE_STATUSES = new Set(['active', 'revoked', 'retired']);
export const CLIENT_SESSION_STATUSES = new Set(['active', 'disconnected', 'expired']);
export const CLIENT_PRESENCE_STATES = new Set(['online', 'offline', 'away', 'busy']);
export const CLIENT_PLATFORMS = new Set(['web', 'ios', 'android', 'desktop', 'server', 'unknown']);
export const CLIENT_TRANSPORTS = new Set(['ws', 'http', 'rtc', 'unknown']);
export const CLIENT_EVENT_TYPES = new Set([
    'principal-created',
    'principal-updated',
    'principal-disabled',
    'principal-deleted',
    'instance-registered',
    'instance-updated',
    'instance-revoked',
    'session-authenticated',
    'session-connected',
    'session-heartbeat',
    'session-disconnected',
    'session-expired'
]);

export type ClientMutationIssuedSessionAuthority = Readonly<{
    kind: 'issued-session';
    version: 1;
    principalId: string;
    sessionId: string;
    sessionIssuedAtEpochMs: number;
    sessionExpiresAtEpochMs: number;
    applicationId: string;
    workspaceId: string;
    operation: Exclude<ClientMutationOperation, 'expireSession'>;
}>;

export type ClientMutationSystemAuthority = Readonly<{
    kind: 'system';
    version: 1;
    serviceId: string;
    operation: 'expireSession';
}>;

export type ClientMutationAuthority = ClientMutationIssuedSessionAuthority | ClientMutationSystemAuthority;

type ClientMutationCommandBase = Readonly<{
    aggregateRef: ClientPrincipalRef;
    commandId: string;
    requestId: string | null;
    facts: ClientMutationFacts;
    authority: ClientMutationAuthority;
}>;

export type ClientMutationCommand =
    | (
        & ClientMutationCommandBase
        & Readonly<{
            operation: 'upsertPrincipal';
            input:
                & NullableActorInput
                & Readonly<{
                    username: string;
                    displayName: string | null;
                    avatarUrl: string | null;
                    status: ClientPrincipalStatus | null;
                    authProvider: string | null;
                    externalSubjectId: string | null;
                    roles: readonly string[] | null;
                    metadata: Readonly<Record<string, unknown>> | null;
                    lastSeenAtEpochMs: number | null;
                }>;
        }>
    )
    | (
        & ClientMutationCommandBase
        & Readonly<{
            operation: 'upsertInstance';
            clientInstanceId: string;
            input:
                & NullableActorInput
                & Readonly<{
                    status: ClientInstance['status'] | null;
                    platform: ClientPlatform | null;
                    deviceLabel: string | null;
                    appVersion: string | null;
                    userAgent: string | null;
                    capabilities: readonly string[] | null;
                }>;
        }>
    )
    | (
        & ClientMutationCommandBase
        & Readonly<{
            operation: 'connectSession' | 'connectAuthorisedWsSession';
            clientInstanceId: string;
            sessionId: string;
            input:
                & NullableActorInput
                & Readonly<{
                    generationId: string;
                    presenceState: ClientPresenceState | null;
                    transport: ClientTransport | null;
                    connectionId: string | null;
                    authenticatedAtEpochMs: number | null;
                    connectedAtEpochMs: number | null;
                    lastHeartbeatAtEpochMs: number | null;
                    expiresAtEpochMs: number | null;
                    instancePlatform: ClientPlatform | null;
                    instanceUserAgent: string | null;
                    instanceCapabilities: readonly string[] | null;
                    principalUsername: string | null;
                    principalDisplayName: string | null;
                    principalRoles: readonly string[] | null;
                }>;
        }>
    )
    | (
        & ClientMutationCommandBase
        & Readonly<{
            operation: 'heartbeatSession';
            clientInstanceId: string;
            sessionId: string;
            input:
                & NullableActorInput
                & Readonly<{
                    generationId: string;
                    presenceState: ClientPresenceState | null;
                    lastHeartbeatAtEpochMs: number | null;
                    expiresAtEpochMs: number | null;
                }>;
        }>
    )
    | (
        & ClientMutationCommandBase
        & Readonly<{
            operation: 'disconnectSession' | 'disconnectAuthorisedWsSession';
            clientInstanceId: string;
            sessionId: string;
            input:
                & NullableActorInput
                & Readonly<{
                    generationId: string;
                    disconnectedAtEpochMs: number | null;
                    lastHeartbeatAtEpochMs: number | null;
                    expiresAtEpochMs: number | null;
                }>;
        }>
    )
    | (
        & ClientMutationCommandBase
        & Readonly<{
            operation: 'expireSession';
            clientInstanceId: string;
            sessionId: string;
            input:
                & NullableActorInput
                & Readonly<{
                    generationId: string;
                    generationVersion: number;
                    observedExpiresAtEpochMs: number;
                    expiresAtEpochMs: number;
                }>;
        }>
    );

export type ClientMutationRead = Readonly<{
    authoritySession: PersistedAuthSession | null;
    idempotency: RuntimeStateEntryValue<ClientMutationIdempotencyRecord> | null;
    principal: RuntimeStateEntryValue<ClientPrincipal> | null;
    instance: RuntimeStateEntryValue<ClientInstance> | null;
    session: RuntimeStateEntryValue<ClientSession> | null;
    expiredSessionEntry: RuntimeStateEntry | null;
    snapshot: ClientSnapshot | null;
    receiptEvent: ClientEvent | null;
}>;

export type ClientMutationFacts = Readonly<{
    nowEpochMs: number;
    serviceId: string;
    eventId: string;
    commandHash: string;
    attemptCount: number;
    expireAtEpochMs: number;
}>;

export type ClientMutationCommandInput = ClientMutationCommand extends infer Command ?
    Command extends ClientMutationCommand ? Omit<Command, 'facts' | 'authority'> :
    never :
    never;

export type ConditionalCandidate<T> =
    | Readonly<{ operation: 'none'; }>
    | Readonly<{ operation: 'insert'; value: T; }>
    | Readonly<{ operation: 'update'; value: T; expectedRevision: number; }>;

export type ClientMutationComputedPersistedNoOp = Readonly<{
    outcome: 'no-op';
    persistIdempotency: true;
    aggregateRef: ClientPrincipalRef;
    idempotency: ClientMutationIdempotencyRecord;
    receipt: ClientMutationReceipt;
    snapshot: ClientSnapshot;
    event: null;
}>;

export type ClientMutationComputedNonPersistedNoOp = Readonly<{
    outcome: 'no-op';
    persistIdempotency: false;
    receipt: ClientMutationReceipt;
    snapshot: ClientSnapshot;
    event: null;
}>;

export type ClientMutationComputedAppliedWrite = Readonly<{
    outcome: 'write';
    principal: Exclude<ConditionalCandidate<ClientPrincipal>, { operation: 'none'; }>;
    instance: ConditionalCandidate<ClientInstance>;
    session: ConditionalCandidate<ClientSession>;
    event: ClientEvent;
    snapshot: ClientSnapshot;
    receipt: ClientMutationReceipt;
    idempotency: ClientMutationIdempotencyRecord | null;
    stateSync: readonly ComputedClientStateSync[];
    outboxEntries: readonly ResourceEntry[];
}>;

export type ClientMutationComputedWrite = ClientMutationComputedAppliedWrite | ClientMutationComputedPersistedNoOp;

export type ClientMutationComputed =
    | Readonly<{
        outcome: 'replay';
        receipt: ClientMutationReceipt;
        snapshot: ClientSnapshot;
        event: ClientEvent | null;
    }>
    | ClientMutationComputedPersistedNoOp
    | ClientMutationComputedNonPersistedNoOp
    | Readonly<{
        outcome: 'idempotency-conflict';
        existingCommandHash: string;
        receivedCommandHash: string;
    }>
    | ClientMutationComputedAppliedWrite;
