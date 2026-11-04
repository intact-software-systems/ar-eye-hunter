import { GROUP_MOVE_PROPOSAL_TTL_MS, type GroupMove } from '@shared/api/mutation/group-move.ts';
import { Either } from '@shared/resilience/Either.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE } from '../../auth/persistence/auth-storage-keys.ts';
import {
    validateComputedEitherProjection,
    validateComputedProjection,
    type ComputedDataValidationIssue
} from '../../computed-data-validation.ts';
import { PARTY_RECORDS_NAMESPACE } from '../../parties/persistence/party-account.ts';
import { computeGuardedViewPublication } from '../../websocket/outbox/guarded-view-publication.ts';
import type { GroupCohortAdmissionParticipant } from '../mutation/membership/compute-group-cohort-admission.ts';
import { groupStateUpdateGroupDescriptor } from '../persistence/aggregate/group-aggregate-write-descriptors.ts';
import {
    groupStateInsertPresenceAdmissionDescriptor,
    groupStateUpdatePresenceAdmissionDescriptor
} from '../persistence/presence/group-presence-write-descriptors.ts';
import { computeGroupMoveAdmission, type GroupMoveAdmissionResult } from './compute-group-move-admission.ts';
import { computeGroupMove, type GroupMoveRejection } from './compute-group-move.ts';
import { decodeGroupMoveRecord, type GroupMoveRecord } from './group-move-codec.ts';
import type { GroupMoveHistoryDeadline } from './group-move-deadline.ts';
import { computeGroupMoveHistoryPublication, computeGroupMovePublication } from './group-move-outbox.ts';
import { computeGroupMoveStorage } from './group-move-repository.ts';
import type { GroupMoveService } from './group-move-service.ts';

export function computeGroupMoveMutation(
    read: GroupMoveService.Read
): Either<GroupMoveRejection, GroupMoveService.Computed> {
    const { command } = read.ingress;
    const previous = read.storage.record?.value ?? null;
    const input = {
        proposal: previous?.move ?? null,
        partySelection: command.party ?? null,
        party: read.party?.record ?? null,
        source: previous !== null && !read.participantAuthorityLive ? null : read.source?.snapshot ?? null,
        sourceRef: command.source,
        destination: command.destination,
        moveId: command.moveId,
        action: command.action,
        actor: { principalId: command.actorPrincipalId, sessionId: command.actorSessionId },
        nowEpochMs: read.nowEpochMs,
        admission: { status: 'admitted' as const, mutations: [] }
    };
    const transition = computeGroupMove(input);
    if (transition.left !== undefined) {
        return Either.ofLeft(transition.left);
    }
    if (
        previous === null &&
        !transition.right!.participants.every((participant) =>
            read.sessions.some((stored) =>
                stored.value.sessionId === participant.sessionId &&
                stored.value.clientId === participant.principalId
            )
        )
    ) {
        return Either.ofLeft({
            code: 'group-move-rejected',
            message: 'A selected source player no longer has a live authenticated session.'
        });
    }
    const admission = transition.right?.status === 'committed' && previous?.move.status === 'proposed'
        ? computeGroupMoveAdmission({ participants: read.admissions })
        : null;
    const decision = admission === null ? transition : computeGroupMove({ ...input, admission });
    return decision.flatMap<GroupMoveRejection, GroupMoveService.Computed>(
        Either.ofLeft,
        (result) => computeWrite(read, result, admission)
    );
}

function computeWrite(
    read: GroupMoveService.Read,
    result: GroupMove,
    admission: GroupMoveAdmissionResult | null
): Either<GroupMoveRejection, GroupMoveService.Computed> {
    const record = nextRecord(read, result);
    const prepared = computeGroupMoveStorage({
        read: read.storage,
        record,
        terminalRetentionMs: read.finishedRetentionMs
    });
    return prepared.mapRight((storage) => computeEffects({ read, result, admission, prepared: storage }));
}

function computeEffects(input: GroupMoveService.EffectsInput): GroupMoveService.Computed {
    const { read, result, admission, prepared } = input;
    const publication = computeGroupMovePublication({
        move: result,
        revision: (read.storage.record?.entry.revision ?? -1) + 1,
        createdAtEpochMs: read.nowEpochMs,
        retentionMs: read.finishedRetentionMs,
        serviceId: read.serviceId,
        traceId: read.traceId,
        previousStatus: read.storage.record?.value.move.status ?? null
    });
    const storage = computeRuntimeStateGuardedBatchWrite({
        ...prepared,
        effects: [...prepared.effects, ...publication.provenance]
    });
    const selectedSessions = new Set(result.participants.map((participant) => participant.sessionId));
    const authEffects = read.sessions.filter((stored) => selectedSessions.has(stored.value.sessionId))
        .map((stored): RuntimeStateGuardedBatchEffect => ({
            effectId: `auth:${stored.value.sessionId}`,
            operation: 'update',
            namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            key: stored.entry.key,
            value: stored.entry.value,
            expireAtTimestamp: stored.entry.expireAtTimestamp,
            expectedRevision: stored.entry.revision
        }));
    const partyEntry = read.party?.entry;
    if (partyEntry) {
        authEffects.push({
            effectId: 'party',
            operation: 'update',
            namespace: PARTY_RECORDS_NAMESPACE,
            key: partyEntry.key,
            value: partyEntry.value,
            expireAtTimestamp: partyEntry.expireAtTimestamp,
            expectedRevision: partyEntry.revision
        });
    }
    const destinationEffects = admission === null
        ? []
        : admissionAuthority(read.admissions, admission.status !== 'admitted' || admission.mutations.length === 0);
    return {
        result,
        outbox: publication.outbox,
        authority: read.source === null
            ? null
            : computeRuntimeStateGuardedBatchWrite({
                ...read.source.guard,
                effects: [...read.source.guard.effects, ...authEffects, ...destinationEffects]
            }),
        storage: read.source === null
            ? computeRuntimeStateGuardedBatchWrite({
                ...storage,
                effects: [...storage.effects, ...authEffects, ...destinationEffects]
            })
            : storage,
        admissions: result.status === 'committed' && admission?.status === 'admitted' ? admission.mutations : []
    };
}

export function validateGroupMoveMutation(
    read: GroupMoveService.Read,
    computed: Either<GroupMoveRejection, GroupMoveService.Computed>
): readonly ComputedDataValidationIssue[] {
    return validateComputedEitherProjection(computeGroupMoveMutation(read), computed, 'group move');
}

export function computeGroupMoveExpiry(read: GroupMoveService.ExpiryRead): GroupMoveService.ExpiryComputed {
    if ('kind' in read.command) {
        return computeHistoryExpiry(read, read.command);
    }
    const previous = read.storage?.record?.value;
    if (
        !previous || previous.move.createdAtEpochMs !== read.command.expiresAtEpochMs - GROUP_MOVE_PROPOSAL_TTL_MS ||
        previous.move.expiresAtEpochMs !== read.command.expiresAtEpochMs
    ) {
        return { kind: 'proposal-expiry', result: null, mutation: null };
    }
    if (previous.move.status !== 'proposed') {
        return { kind: 'proposal-expiry', result: previous.move, mutation: null };
    }
    if (read.nowEpochMs < previous.move.expiresAtEpochMs) {
        throw new Error('Group move deadline is not due; retry after the deadline');
    }
    const result: GroupMove = {
        ...previous.move,
        status: 'expired',
        reason: 'proposal-expired',
        completedAtEpochMs: read.nowEpochMs
    };
    const storage = computeGroupMoveStorage({
        read: read.storage!,
        record: { move: result, credentials: [] },
        terminalRetentionMs: read.finishedRetentionMs
    });
    const prepared = storage.fold((rejection) => {
        throw new TypeError(`Expiry claim invariant: ${rejection.message}`);
    }, (value) => value);
    const publication = computeGroupMovePublication({
        move: result,
        revision: read.storage!.record!.entry.revision + 1,
        createdAtEpochMs: read.nowEpochMs,
        retentionMs: read.finishedRetentionMs,
        serviceId: read.serviceId,
        traceId: read.traceId,
        previousStatus: previous.move.status
    });
    return {
        kind: 'proposal-expiry',
        result,
        mutation: {
            result,
            authority: null,
            admissions: [],
            outbox: publication.outbox,
            storage: computeRuntimeStateGuardedBatchWrite({
                ...prepared,
                effects: [...prepared.effects, ...publication.provenance]
            })
        }
    };
}

function computeHistoryExpiry(
    read: GroupMoveService.ExpiryRead,
    command: GroupMoveHistoryDeadline
): GroupMoveService.ExpiryComputed {
    if (read.nowEpochMs < command.dueAtEpochMs) {
        throw new Error('Group move history removal is not due');
    }
    const publication = computeGroupMoveHistoryPublication(command, {
        createdAtEpochMs: read.nowEpochMs,
        retentionMs: read.finishedRetentionMs,
        serviceId: read.serviceId,
        traceId: read.traceId
    });
    const [first, ...effects] = publication.provenance;
    if (first?.operation !== 'insert') {
        throw new TypeError('Move history notification lacks its first provenance insert');
    }
    const guard = {
        operation: first.operation,
        namespace: first.namespace,
        key: first.key,
        value: first.value,
        expireAtTimestamp: first.expireAtTimestamp
    };
    return {
        kind: 'terminal-retention',
        result: null,
        publication: computeGuardedViewPublication({ guard, effects }, publication.outbox)
    };
}

export function validateGroupMoveExpiry(
    read: GroupMoveService.ExpiryRead,
    computed: GroupMoveService.ExpiryComputed
): readonly ComputedDataValidationIssue[] {
    return validateComputedProjection(computeGroupMoveExpiry(read), computed, 'group move expiry');
}

function nextRecord(read: GroupMoveService.Read, move: GroupMove): GroupMoveRecord {
    const previous = read.storage.record?.value;
    const { command, admission } = read.ingress;
    const retained = (previous?.credentials ?? []).filter((credential) =>
        command.action !== 'withdraw' || credential.sessionId !== command.actorSessionId
    );
    const credentials = move.status !== 'proposed' ? [] : command.action === 'confirm' && admission !== null
        ? [...retained.filter((credential) => credential.sessionId !== command.actorSessionId), {
            sessionId: command.actorSessionId,
            admission
        }]
        : retained;
    return decodeGroupMoveRecord({ move, credentials });
}
function admissionAuthority(
    participants: readonly GroupCohortAdmissionParticipant[],
    guardGroup: boolean
): RuntimeStateGuardedBatchEffect[] {
    const group = participants[0]?.read.group;
    if (!group) {
        return [];
    }
    const effects: RuntimeStateGuardedBatchEffect[] = guardGroup
        ? [{ effectId: 'destination', ...groupStateUpdateGroupDescriptor(group.value, group.entry.revision) }]
        : [];
    const seen = new Set<string>();
    for (const participant of participants) {
        const principalId = participant.command.targetPrincipalId;
        if (seen.has(principalId)) {
            continue;
        }
        seen.add(principalId);
        const stored = participant.read.targetAdmission;
        effects.push({
            effectId: `destination-admission:${principalId}`,
            ...(stored
                ? groupStateUpdatePresenceAdmissionDescriptor(stored.value, stored.entry.revision)
                : groupStateInsertPresenceAdmissionDescriptor({
                    ...participant.command.aggregateRef,
                    principalId,
                    admittedSessions: [],
                    updatedAtEpochMs: participant.facts.attemptAtEpochMs
                }))
        });
    }
    return effects;
}
