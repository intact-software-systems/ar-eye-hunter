import type {
    ClientEvent,
    ClientPlatform,
    ClientPresenceSnapshot,
    ClientPrincipalRef,
    ClientScope,
    ClientSession,
    ClientSnapshot
} from '@shared/api/client-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '../../runtime-state/runtime-state-repository.ts';
import type { PersistedAuthSession } from '../auth/persistence/auth-persistence-contracts.ts';
import type { ClientSessionExpiryCandidate } from '../presence/session-expiry.ts';
import type { ClientStateEventStore } from '../state-events/client-state-event-store.ts';
import type { StateEventListQuery } from '../state-events/state-event-listing.ts';
import type { WsSessionGenerationLifecycleService } from '../websocket/ws-session-generation-lifecycle.ts';
import type {
    ClientMutationCommand,
    ClientMutationComputed,
    ClientMutationComputedWrite,
    ClientMutationRead,
    ClientMutationReceipt
} from './mutation/client-mutation-contracts.ts';
import { assertNeverClientMutationComputed } from './mutation/compute/compute-client-mutation-result.ts';

export type RegisterAuthorisedWsClientInput = Readonly<{
    applicationId?: string;
    workspaceId?: string;
    principalId?: string;
    clientInstanceId?: string;
    displayName?: string;
    userAgent?: string;
    platform?: ClientPlatform;
    capabilities?: readonly string[];
    connectedAtEpochMs?: number;
    expiresAtEpochMs?: number;
}>;

export type ClientMutationWritten = Readonly<{
    snapshot: ClientSnapshot;
    event: ClientEvent | null;
}>;

export type ClientStateWritten = Readonly<{
    status: 'ok';
    result: ClientMutationWritten;
}>;

export type ClientStateService = Readonly<{
    sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
    listSnapshots(scope: ClientScope): Promise<readonly ClientSnapshot[]>;
    readSnapshot(ref: ClientPrincipalRef): Promise<ClientSnapshot | undefined>;
    readPresenceSnapshot(ref: ClientPrincipalRef): Promise<ClientPresenceSnapshot | undefined>;
    listEvents(ref: ClientPrincipalRef): Promise<readonly ClientEvent[]>;
    listRecentEvents(
        ref: ClientPrincipalRef,
        query: StateEventListQuery
    ): Promise<readonly ClientEvent[]>;
    listEventPage(
        ref: ClientPrincipalRef,
        query: StateEventListQuery
    ): Promise<StateEventPage<ClientEvent>>;
    read(command: ClientMutationCommand): Promise<ClientMutationRead>;
    compute(command: ClientMutationCommand, read: ClientMutationRead): ClientMutationComputed;
    validate(
        command: ClientMutationCommand,
        read: ClientMutationRead,
        computed: ClientMutationComputed
    ): void;
    write(
        transaction: PSqlSql,
        computed: ClientMutationComputedWrite
    ): Promise<ClientMutationReceipt>;
    listExpiredSessionCandidates(atEpochMs: number): Promise<readonly ClientSessionExpiryCandidate[]>;
    findSessionBySessionId(sessionId: string): Promise<ClientSession | undefined>;
    readIssuedAuthSession(sessionId: string): Promise<PersistedAuthSession | undefined>;
    observeSnapshot(snapshot: ClientSnapshot): Promise<ClientSnapshot>;
}>;

export type ClientStateMutationService = Pick<ClientStateService, 'read' | 'compute' | 'validate' | 'write'>;

export type ClientStateServiceDependencies = Readonly<{
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    clientStateEventStore: ClientStateEventStore;
    serviceId: string;
    timing?: import('../observability/timing.ts').RallarTimingSink;
}>;

export function requiresClientWrite(
    computed: ClientMutationComputed
): computed is ClientMutationComputedWrite {
    switch (computed.outcome) {
        case 'write':
            return true;
        case 'no-op':
            return computed.persistIdempotency;
        case 'replay':
        case 'idempotency-conflict':
            return false;
        default:
            return assertNeverClientMutationComputed(computed);
    }
}

export function toClientMutationReceipt(
    computed: Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict'; }>
): ClientMutationReceipt {
    return computed.receipt;
}

export function toClientStateWritten(
    computed: Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict'; }>
): ClientStateWritten {
    switch (computed.outcome) {
        case 'write':
        case 'no-op':
        case 'replay':
            break;
        default:
            return assertNeverClientMutationComputed(computed);
    }
    return {
        status: 'ok',
        result: {
            snapshot: computed.snapshot,
            event: computed.event
        }
    };
}
