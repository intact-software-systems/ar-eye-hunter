import type { PartyMutationResult } from '@shared/api/parties/party-request.ts';
import type { PartyRefusal } from '@shared/api/parties/party.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { Either } from '@shared/resilience/Either.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateConditionalBatch } from '../../runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import type { RuntimeStateEntry } from '../../runtime-state/runtime-state-repository.ts';
import type { AppOutboxInsert } from '../app-outbox/app-outbox-insert.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE } from '../auth/persistence/auth-storage-keys.ts';
import { CLIENT_STATE_PRINCIPALS_NAMESPACE } from '../client-state/persistence/client-state-runtime-namespaces.ts';
import { validateComputedProjection, type ComputedDataValidationIssue } from '../computed-data-validation.ts';
import { FRIENDS_PROFILE_NAMESPACE } from '../friends/friends-profile.ts';
import { computeMatchmakingPublication } from '../matchmaking/compute-matchmaking-publication.ts';
import { computeMatchmakingStorage } from '../matchmaking/compute-matchmaking-storage.ts';
import { computeMatchmakingInvalidation } from '../matchmaking/compute-matchmaking.ts';
import { computeSha256CanonicalJson } from '../protocol/compute-sha256-canonical-json.ts';
import {
    computeViewInvalidationPublication,
    type ViewInvalidationPublication
} from '../websocket/outbox/compute-view-invalidation-publication.ts';
import { computePartyRoster, type PartyRosterComputed } from './compute-party-roster.ts';
import type { PartyService } from './party-service.ts';
import { computePartyStorage } from './persistence/compute-party-storage.ts';
import type { PartyRecord } from './persistence/party-record.ts';

export interface PartyMutation {
    readonly storage: RuntimeStateConditionalBatch | null;
    readonly outbox: readonly AppOutboxInsert[];
    readonly matchmaking: RuntimeStateConditionalBatch | null;
    readonly result: PartyMutationResult;
    readonly rosterChanged: boolean;
}

export function computePartyMutation(read: PartyService.Read): PartyMutation {
    const { command } = read;
    const { ref } = command.request;
    const decision = computePartyRosterDecision(read);
    if (decision.left !== undefined) {
        return refused(read, decision.left);
    }
    const computed = decision.right!;
    const storage = computePartyStorage({ read: read.party, party: computed.party });
    const authority = computePartyAuthority(read);
    const matchmaking = computed.rosterChanged ? computeRosterSearchInvalidation(read) : null;
    const publication = computePartyPublication(read, computed.party);
    return {
        matchmaking: matchmaking?.storage ?? null,
        outbox: [...publication.outbox, ...matchmaking?.outbox ?? []],
        storage: {
            ...storage,
            batch: computeRuntimeStateGuardedBatchWrite({
                ...storage.batch,
                effects: [...storage.batch.effects, ...authority, ...publication.provenance]
            })
        },
        rosterChanged: computed.rosterChanged,
        result: { ref, principalId: command.principalId, requestId: command.requestId, status: 'applied', code: null }
    };
}

function computePartyPublication(read: PartyService.Read, party: PartyRecord): ViewInvalidationPublication {
    const { ref } = party;
    return computeViewInvalidationPublication({
        resource: 'party',
        scope: { applicationId: ref.applicationId, workspaceId: ref.workspaceId },
        principalIds: [
            ...new Set([
                ...read.party.record?.members.map((member) => member.principalId) ?? [],
                ...read.party.record?.invitations.map((invitation) => invitation.principalId) ?? [],
                ...party.members.map((member) => member.principalId),
                ...party.invitations.map((invitation) => invitation.principalId)
            ])
        ],
        changeId: computeSha256CanonicalJson({ previousRevision: read.party.entry?.revision ?? 0, party: party }),
        serviceId: read.serviceId,
        traceId: read.traceId,
        createdAtEpochMs: read.nowEpochMs,
        retentionMs: read.finishedRetentionMs
    });
}

function computePartyRosterDecision(read: PartyService.Read): Either<PartyRefusal, PartyRosterComputed> {
    const { command } = read;
    const session = read.session?.value;
    if (
        session === undefined || session.clientId !== command.principalId || session.sessionId !== command.sessionId ||
        session.issuedAtEpochMs !== command.sessionIssuedAtEpochMs ||
        session.expiresAtEpochMs !== command.sessionExpiresAtEpochMs ||
        session.expiresAtEpochMs <= read.nowEpochMs
    ) {
        return Either.ofLeft('unauthorized');
    }
    if (command.capturedAtEpochMs === null || command.policy === null) {
        throw new TypeError('Party execution requires winning ingress facts');
    }
    const { intent, ref, expectedRosterRevision } = command.request;
    const presentPrincipalIds = read.presence.filter((stored) =>
        stored.snapshot.principal.status === 'active' &&
        stored.snapshot.activeSessions.some((session) =>
            session.status === 'active' && session.disconnectedAtEpochMs === null &&
            session.expiresAtEpochMs > read.nowEpochMs
        )
    ).map((stored) => stored.snapshot.principal.principalId);
    if (
        (intent.action === 'create' || intent.action === 'accept') && !presentPrincipalIds.includes(command.principalId)
    ) {
        return Either.ofLeft('member-away');
    }
    const actor = read.party.accounts.find((stored) => stored.account.principalId === command.principalId);
    if (actor === undefined) {
        throw new TypeError('Party command is missing its exact actor account read');
    }
    const target = intent.action === 'invite'
        ? read.party.accounts.find((stored) => stored.account.principalId === intent.principalId)
        : undefined;
    if (intent.action === 'invite' && target === undefined) {
        throw new TypeError('Party invitation is missing its exact recipient account read');
    }
    return computePartyRoster({
        ref,
        record: read.party.record,
        actorPrincipalId: command.principalId,
        actorPartyId: actor.account.partyId,
        targetPartyId: target?.account.partyId ?? null,
        targetInvitationCount: target?.account.invitations.filter((invitation) =>
            invitation.expiresAtEpochMs > read.nowEpochMs
        ).length ?? 0,
        expectedRosterRevision,
        intent,
        friendship: read.friendship,
        presentPrincipalIds,
        capturedAtEpochMs: command.capturedAtEpochMs,
        nowEpochMs: read.nowEpochMs,
        policy: command.policy
    });
}

export function validatePartyMutation(
    read: PartyService.Read,
    computed: PartyMutation
): readonly ComputedDataValidationIssue[] {
    return validateComputedProjection(computePartyMutation(read), computed, 'Party mutation');
}

function computePartyAuthority(read: PartyService.Read): readonly RuntimeStateGuardedBatchEffect[] {
    if (read.session === null) {
        throw new TypeError('Accepted party mutation requires its issuing session');
    }
    const effects = [guard(AUTH_SESSIONS_BY_SESSION_NAMESPACE, read.session.entry)];
    for (const profile of read.profiles) {
        if (profile.entry === null) {
            throw new TypeError('Accepted party invitation requires persisted reciprocal consent');
        }
        effects.push(guard(FRIENDS_PROFILE_NAMESPACE, profile.entry));
    }
    for (const presence of read.presence) {
        if (presence.principal.entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP) {
            throw new TypeError('Party presence authority must have a durable principal');
        }
        effects.push(guard(CLIENT_STATE_PRINCIPALS_NAMESPACE, presence.principal.entry));
    }
    return effects;
}

function guard(namespace: string, entry: RuntimeStateEntry): RuntimeStateGuardedBatchEffect {
    return {
        effectId: `${namespace}:${entry.key}`,
        operation: 'update',
        namespace,
        key: entry.key,
        value: entry.value,
        expectedRevision: entry.revision,
        expireAtTimestamp: entry.expireAtTimestamp
    };
}

function refused(read: PartyService.Read, code: PartyRefusal): PartyMutation {
    return {
        storage: null,
        outbox: [],
        matchmaking: null,
        rosterChanged: false,
        result: {
            ref: read.command.request.ref,
            principalId: read.command.principalId,
            requestId: read.command.requestId,
            status: 'refused',
            code
        }
    };
}

interface PartySearchInvalidation {
    readonly storage: RuntimeStateConditionalBatch;
    readonly outbox: readonly AppOutboxInsert[];
}

function computeRosterSearchInvalidation(read: PartyService.Read): PartySearchInvalidation {
    if (read.matchmaking === null) {
        throw new TypeError('Party roster changes require the current matchmaking pool');
    }
    const transition = computeMatchmakingInvalidation({
        pool: read.matchmaking.pool,
        partySearches: read.matchmaking.partySearches,
        nowEpochMs: read.nowEpochMs,
        principalIds: [
            ...new Set([
                read.command.principalId,
                ...read.party.record?.members.map((member) => member.principalId) ?? []
            ])
        ]
    });
    const storage = computeMatchmakingStorage({
        read: read.matchmaking,
        transition,
        finishedRetentionMs: read.finishedRetentionMs
    });
    const publication = computeMatchmakingPublication({
        before: read.matchmaking.pool,
        previousRevision: read.matchmaking.entry?.revision ?? 0,
        transition,
        publication: {
            serviceId: read.serviceId,
            traceId: read.traceId,
            createdAtEpochMs: read.nowEpochMs,
            retentionMs: read.finishedRetentionMs
        }
    });
    return {
        storage: {
            ...storage,
            batch: computeRuntimeStateGuardedBatchWrite({
                ...storage.batch,
                effects: [...storage.batch.effects, ...publication.provenance]
            })
        },
        outbox: publication.outbox
    };
}
