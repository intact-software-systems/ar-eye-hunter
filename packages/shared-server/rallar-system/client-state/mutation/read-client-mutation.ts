import type { ClientInstanceRef, ClientSessionRef } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { ViewWatchRepository } from '../../view-watch/view-watch-repository.ts';
import { readViewWatchSessionCleanup } from '../../view-watch/view-watch-session-cleanup.ts';
import {
    clientMutationSocialSelectors,
    decodeClientMutationSocialRead,
    type ClientMutationSocialRead
} from './client-mutation-social-read.ts';

import type { RuntimeStateReadBatchLiveSelection } from '../../../runtime-state/read-batch/resolve-runtime-state-read-batch-live-values.ts';
import type { RuntimeStateReadBatchSelector } from '../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import { decodeAuthSessionBySessionIdEntry } from '../../auth/persistence/auth-session-persistence.ts';
import {
    AUTH_SESSIONS_BY_SESSION_NAMESPACE,
    authSessionKey,
    authTicketDigestKey,
    WS_AUTH_TICKETS_NAMESPACE
} from '../../auth/persistence/auth-storage-keys.ts';
import { decodeWebSocketTicketByDigestEntry } from '../../auth/persistence/auth-ticket-persistence.ts';
import type { PersistedAuthSession } from '../../auth/persistence/persisted-auth-session.ts';
import type { AuthWsTicketConsumptionClaim } from '../../auth/ws-ticket/auth-ws-ticket-consumption.ts';
import { readFriendsPresence } from '../../friends/compute-friends-presence-publication.ts';
import type { FriendsRepository } from '../../friends/friends-repository.ts';
import { GroupStateRepositoryReads } from '../../group-state/persistence/group-state-repository-reads.ts';
import { readGroupVisibility } from '../../group-state/policy/group-snapshot-visibility-policy.ts';
import type { GroupStateCurrentSnapshotCache } from '../../group-state/snapshot/group-state-current-snapshot-cache.ts';
import { readPartyMemberView } from '../../parties/party-member-view-publication.ts';
import type { PartyRepository } from '../../parties/persistence/party-repository.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { PrincipalAudienceSessions } from '../../state-sync/state-sync-principal-audience.ts';
import {
    toWsSessionLifecycleKey,
    WS_SESSION_CLOSE_HIGH_WATER_NAMESPACE,
    type WsSessionHighWaterIdentity
} from '../../websocket/ws-session-generation-computation.ts';
import { toWsSessionGenerationLifecycleRead } from '../../websocket/ws-session-generation-lifecycle.ts';
import { timeClientStateReadPhase, type ClientStateMutationTiming } from '../client-state-service-timing.ts';
import { ClientStateRepository } from '../persistence/client-state-repository.ts';
import { ClientMutationRejectedError } from '../validation/client-mutation-rejection.ts';
import type {
    ClientAuthorisedWsConnectRead,
    ClientAuthorisedWsConnectReadInput,
    ClientMutationCommand,
    ClientMutationRead
} from './client-mutation-contracts.ts';
import { resolveClientMutationAudienceReadScope } from './resolve-client-mutation-audience-read-scope.ts';

interface ClientMutationTargetRefs {
    readonly instanceRef: ClientInstanceRef | null;
    readonly sessionRef: ClientSessionRef | null;
}

interface ClientMutationAudienceRead {
    readonly audienceGroupSnapshots: readonly GroupSnapshot[];
    readonly audienceCoMemberSessions: readonly PrincipalAudienceSessions[];
}

export interface ReadClientMutationInput {
    readonly repository: ClientStateRepository;
    readonly groupRepository: GroupStateRepositoryReads;
    readonly parties: PartyRepository;
    readonly friends: FriendsRepository;
    readonly viewWatches: ViewWatchRepository;
    readonly command: ClientMutationCommand;
    readonly audienceObservedAtEpochMs: number;
    readonly timing?: ClientStateMutationTiming;
    readonly currentGroupSnapshots?: Pick<GroupStateCurrentSnapshotCache, 'readSnapshots'>;
}

export type ReadAuthorisedWsConnectMutationInput =
    & ReadClientMutationInput
    & Omit<ClientAuthorisedWsConnectReadInput, 'command'>;

type ClientMutationStateRead = Pick<
    ClientMutationRead,
    'authoritySession' | 'idempotency' | 'principal' | 'instance' | 'session' | 'expiredSessionEntry' | 'snapshot'
>;

/** Auth sessions and rows of other features that one mutation's point statement reads beside its own rows. */
interface ClientMutationCompanionRead {
    readonly authSessionIds: readonly string[];
    readonly selectors: readonly RuntimeStateReadBatchSelector[];
}

interface ClientMutationStateBatchRead {
    readonly social: ClientMutationSocialRead;
    readonly state: ClientMutationStateRead;
    readonly authSessions: ReadonlyMap<string, RuntimeStateEntryValue<PersistedAuthSession>>;
    readonly companions: readonly RuntimeStateReadBatchLiveSelection<JsonWireValue>[];
}

const NO_COMPANIONS: ClientMutationCompanionRead = { authSessionIds: [], selectors: [] };

const EMPTY_AUDIENCE_READ: ClientMutationAudienceRead = {
    audienceGroupSnapshots: [],
    audienceCoMemberSessions: []
};

export async function readClientMutation(
    input: ReadClientMutationInput
): Promise<ClientMutationRead> {
    const { state, social } = await timeClientStateReadPhase(
        { timing: input.timing, command: input.command, operation: 'mutation.read-state' },
        () => readClientMutationState(input, NO_COMPANIONS)
    );
    return await readClientMutationAudience(input, state, social);
}

/** The connect's ticket, its session and close high-water join the mutation's own point statement. */
export async function readAuthorisedWsConnectMutation(
    input: ReadAuthorisedWsConnectMutationInput
): Promise<ClientAuthorisedWsConnectRead> {
    const { ticketClaim, lifecycle } = input;
    const { state, authSessions, companions, social } = await timeClientStateReadPhase(
        { timing: input.timing, command: input.command, operation: 'mutation.read-state' },
        () =>
            readClientMutationState(input, {
                authSessionIds: [ticketClaim.sessionId],
                selectors: [toWsTicketSelector(ticketClaim), toWsSessionHighWaterSelector(lifecycle)]
            })
    );
    const [ticket, highWater] = companions;
    const [storedTicket] = ticket.entries;
    return {
        ticket: {
            ticket: storedTicket ? decodeWebSocketTicketByDigestEntry(ticketClaim.ticketDigest, storedTicket) : null,
            session: authSessions.get(ticketClaim.sessionId) ?? null
        },
        lifecycle: toWsSessionGenerationLifecycleRead(
            lifecycle,
            highWater.entries[0]?.entry ?? highWater.expiredEntries[0]
        ),
        mutation: await readClientMutationAudience(input, state, social)
    };
}

async function readClientMutationAudience(
    input: ReadClientMutationInput,
    state: ClientMutationStateRead,
    social: ClientMutationSocialRead
): Promise<ClientMutationRead> {
    const { repository, command, audienceObservedAtEpochMs, timing } = input;
    const receiptEvent = await timeClientStateReadPhase(
        { timing, command, operation: 'mutation.read-receipt' },
        () => readReceiptEvent(repository, command, state.idempotency ?? undefined)
    );
    const audienceScope = resolveClientMutationAudienceReadScope(command, state);
    const audience = audienceScope === 'principal-audience'
        ? await readPrincipalAudience(input)
        : EMPTY_AUDIENCE_READ;

    const partyMemberView = social.partyAccount === null
        ? null
        : await readPartyMemberView(input.parties, command.aggregateRef, social.partyAccount);
    const friendsPresence = social.friendsProfile === null
        ? null
        : await readFriendsPresence(input.friends, social.friendsProfile);
    const viewWatchCleanup = state.idempotency === null
        ? await readViewWatchSessionCleanup(input.viewWatches, command)
        : null;
    return {
        ...state,
        receiptEvent,
        audienceObservedAtEpochMs,
        partyMemberView,
        friendsPresence,
        viewWatchCleanup,
        ...audience
    };
}

async function readClientMutationState(
    input: ReadClientMutationInput,
    companion: ClientMutationCompanionRead
): Promise<ClientMutationStateBatchRead> {
    const { repository, command } = input;
    const targets = toClientMutationTargetRefs(command);
    const authorityIds = command.authority.kind === 'issued-session' ? [command.authority.sessionId] : [];
    const authSessionIds = [...new Set([...authorityIds, ...companion.authSessionIds])];
    const socialSelectors = command.operation === 'upsertInstance' ? [] : clientMutationSocialSelectors(command);
    const batch = await repository.readMutationState({
        principalRef: command.aggregateRef,
        instanceRef: targets.instanceRef,
        sessionRef: targets.sessionRef,
        requestId: command.requestId,
        companionSelectors: [...authSessionIds.map(toAuthSessionSelector), ...companion.selectors, ...socialSelectors]
    });
    const authSessions = new Map(authSessionIds.flatMap((sessionId, index) => {
        const [stored] = batch.companions[index].entries;
        return stored ? [[sessionId, decodeAuthSessionBySessionIdEntry(sessionId, stored)] as const] : [];
    }));
    const [authorityId] = authorityIds;
    const state: ClientMutationStateRead = {
        authoritySession: authorityId === undefined ? null : authSessions.get(authorityId)?.value ?? null,
        idempotency: batch.idempotency ?? null,
        principal: batch.principalSnapshot?.principal ?? null,
        instance: batch.instance ?? null,
        session: batch.session.value ?? null,
        expiredSessionEntry: batch.session.expiredEntry ?? null,
        snapshot: batch.principalSnapshot?.snapshot ?? null
    };
    const socialOffset = authSessionIds.length + companion.selectors.length;
    return {
        state,
        authSessions,
        companions: batch.companions.slice(authSessionIds.length, socialOffset),
        social: decodeClientMutationSocialRead({
            command,
            state,
            selections: batch.companions.slice(socialOffset),
            audienceObservedAtEpochMs: input.audienceObservedAtEpochMs
        })
    };
}

async function readPrincipalAudience(
    input: ReadClientMutationInput
): Promise<ClientMutationAudienceRead> {
    const { repository, groupRepository, command, audienceObservedAtEpochMs, timing } = input;
    const scope = {
        applicationId: command.aggregateRef.applicationId,
        workspaceId: command.aggregateRef.workspaceId
    };
    const audienceGroupSnapshots = await timeClientStateReadPhase(
        { timing, command, operation: 'mutation.read-audience-groups' },
        () =>
            groupRepository.listSnapshotsForPrincipal(
                scope,
                command.aggregateRef.principalId,
                input.currentGroupSnapshots
            )
    );
    const coGroupPrincipalIds = new Set<string>();
    for (const snapshot of audienceGroupSnapshots) {
        if (
            readGroupVisibility({
                snapshot,
                actor: { principalId: command.aggregateRef.principalId },
                nowEpochMs: audienceObservedAtEpochMs
            }) !== 'full'
        ) {
            continue;
        }
        for (const member of snapshot.members) {
            if (
                member.principalId !== command.aggregateRef.principalId &&
                readGroupVisibility({
                        snapshot,
                        actor: { principalId: member.principalId },
                        nowEpochMs: audienceObservedAtEpochMs
                    }) === 'full'
            ) {
                coGroupPrincipalIds.add(member.principalId);
            }
        }
    }
    const audienceCoMemberSessions = await timeClientStateReadPhase(
        { timing, command, operation: 'mutation.read-audience-clients' },
        () =>
            repository.readAudienceSessionsForPrincipals(
                [...coGroupPrincipalIds].map((principalId) => ({ ...scope, principalId }))
            )
    );
    return { audienceGroupSnapshots, audienceCoMemberSessions };
}

function toClientMutationTargetRefs(command: ClientMutationCommand): ClientMutationTargetRefs {
    const instanceRef = 'clientInstanceId' in command
        ? { ...command.aggregateRef, clientInstanceId: command.clientInstanceId }
        : null;
    return {
        instanceRef,
        sessionRef: instanceRef && 'sessionId' in command
            ? { ...instanceRef, sessionId: command.sessionId }
            : null
    };
}

function toAuthSessionSelector(sessionId: string, index: number): RuntimeStateReadBatchSelector {
    return {
        selectorId: `auth-session:${index}`,
        kind: 'key',
        namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE,
        key: authSessionKey(sessionId)
    };
}

function toWsTicketSelector(claim: AuthWsTicketConsumptionClaim): RuntimeStateReadBatchSelector {
    return {
        selectorId: 'ws-ticket',
        kind: 'key',
        namespace: WS_AUTH_TICKETS_NAMESPACE,
        key: authTicketDigestKey(claim.ticketDigest)
    };
}

function toWsSessionHighWaterSelector(identity: WsSessionHighWaterIdentity): RuntimeStateReadBatchSelector {
    return {
        selectorId: 'ws-session-high-water',
        kind: 'key',
        namespace: WS_SESSION_CLOSE_HIGH_WATER_NAMESPACE,
        key: toWsSessionLifecycleKey(identity)
    };
}

async function readReceiptEvent(
    repository: ClientStateRepository,
    command: ClientMutationCommand,
    idempotency: ClientMutationRead['idempotency'] | undefined
) {
    if (!idempotency || idempotency.value.receipt.eventId === null) {
        return null;
    }
    const receiptEvent = (await repository.listEvents(command.aggregateRef)).find(
        (event) => event.eventId === idempotency.value.receipt.eventId
    ) ?? null;
    if (!receiptEvent) {
        throw new ClientMutationRejectedError(
            `Client mutation receipt event not found: ${idempotency.value.receipt.eventId}`
        );
    }
    return receiptEvent;
}
