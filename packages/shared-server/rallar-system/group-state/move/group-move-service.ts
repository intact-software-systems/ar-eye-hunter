import type { GroupMove, GroupMoveRequest } from '@shared/api/mutation/group-move.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type {
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchWrite
} from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { AppInboxCommandAttempt } from '../../app-inbox/app-inbox-contracts.ts';
import { writeAppOutboxInsert, type AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import type { AuthSessionPersistence } from '../../auth/persistence/auth-session-persistence.ts';
import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE } from '../../auth/persistence/auth-storage-keys.ts';
import type { PersistedAuthSession } from '../../auth/persistence/persisted-auth-session.ts';
import { validateComputedEitherProjection, validateComputedProjection } from '../../computed-data-validation.ts';
import {
    createGroupMutationAuthorityProof,
    GroupMutationAuthorizationError,
    mutationDescriptor,
    verifyLiveGroupMutationSession
} from '../group-mutation-authority.ts';
import type { GroupStateService } from '../group-state-service-contracts.ts';
import { type GroupMutationComputedWrite } from '../mutation/group-mutation-contracts.ts';
import { constantTimeHexEqual } from '../mutation/group-state-crypto.ts';
import { toGroupMutationAttemptFacts } from '../mutation/to-group-mutation-attempt-facts.ts';
import { writeGroupMutation } from '../mutation/write/write-group-mutation.ts';
import { groupStateUpdateGroupDescriptor } from '../persistence/aggregate/group-aggregate-write-descriptors.ts';
import type { GroupStateRepository } from '../persistence/group-state-repository.ts';
import {
    groupStateInsertPresenceAdmissionDescriptor,
    groupStateUpdatePresenceAdmissionDescriptor
} from '../persistence/presence/group-presence-write-descriptors.ts';
import { computeGroupMoveAdmission, type GroupMoveAdmissionParticipant } from './compute-group-move-admission.ts';
import { computeGroupMoveSource, type GroupMoveSource } from './compute-group-move-source.ts';
import { computeGroupMove, type GroupMoveRejection } from './compute-group-move.ts';
import { decodeGroupMoveRecord, type GroupMoveRecord } from './group-move-codec.ts';
import {
    decodeGroupMoveCommand,
    decodeGroupMoveIngress,
    decodeGroupMoveRequest,
    type GroupMoveCommand,
    type GroupMoveIngress
} from './group-move-command.ts';
import { computeGroupMovePublication, decodeGroupMoveDeadline, type GroupMoveDeadline } from './group-move-outbox.ts';
import { computeGroupMoveStorage, GroupMoveRepository, writeGroupMoveStorage } from './group-move-repository.ts';

export namespace GroupMoveService {
    export interface Dependencies {
        readonly groups: GroupStateRepository;
        readonly moves: GroupMoveRepository;
        readonly authSessions: AuthSessionPersistence;
        readonly mutations: Pick<GroupStateService, 'captureMutationIngress' | 'read'>;
    }
    export interface Config {
        readonly serviceId: string;
        readonly finishedRetentionMs: number;
        readonly now: () => number;
    }
    export interface Read {
        readonly ingress: GroupMoveIngress;
        readonly traceId: string;
        readonly nowEpochMs: number;
        readonly storage: GroupMoveRepository.Read;
        readonly source: GroupMoveSource | null;
        readonly sessions: readonly RuntimeStateEntryValue<PersistedAuthSession>[];
        readonly participantAuthorityLive: boolean;
        readonly admissions: readonly GroupMoveAdmissionParticipant[];
    }
    export interface ExpiryRead {
        readonly command: GroupMoveDeadline;
        readonly traceId: string;
        readonly nowEpochMs: number;
        readonly storage: GroupMoveRepository.Read | null;
    }
    export interface ExpiryComputed {
        readonly result: GroupMove | null;
        readonly mutation: Computed | null;
    }
    export interface Computed {
        readonly outbox: readonly AppOutboxInsert[];
        readonly result: GroupMove;
        readonly authority: RuntimeStateGuardedBatchWrite | null;
        readonly storage: RuntimeStateGuardedBatchWrite;
        readonly admissions: readonly GroupMutationComputedWrite[];
    }
}

export class GroupMoveService {
    private readonly dependencies: GroupMoveService.Dependencies;
    private readonly config: GroupMoveService.Config;

    constructor(dependencies: GroupMoveService.Dependencies, config: GroupMoveService.Config) {
        this.dependencies = dependencies;
        this.config = config;
    }

    async listForPrincipal(scope: StateScope, principalId: string): Promise<readonly GroupMove[]> {
        return await this.dependencies.moves.listForPrincipal(scope, principalId);
    }

    authorize(request: GroupMoveRequest, session: IssuedAuthSession): GroupMoveCommand {
        if (session.expiresAtEpochMs <= this.config.now()) {
            throw new GroupMutationAuthorizationError('Group moves require a live session');
        }
        return decodeGroupMoveCommand({
            ...decodeGroupMoveRequest(request),
            actorPrincipalId: session.clientId,
            actorSessionId: session.sessionId
        });
    }

    async capture(command: GroupMoveCommand, session: IssuedAuthSession): Promise<GroupMoveIngress> {
        const admission = command.action === 'confirm'
            ? await this.dependencies.mutations.captureMutationIngress(
                mutationDescriptor({
                    operation: 'joinGroup',
                    scope: {
                        applicationId: command.destination.applicationId,
                        workspaceId: command.destination.workspaceId
                    },
                    groupId: command.destination.groupId,
                    request: {
                        requestId: `move:${command.moveId}:${command.actorSessionId}:${command.requestId}`,
                        actorPrincipalId: command.actorPrincipalId,
                        participation: 'player',
                        ...(command.joinCode === null ? {} : { joinCode: command.joinCode }),
                        ...(command.inviteToken === null ? {} : { inviteToken: command.inviteToken })
                    }
                }),
                session
            )
            : null;
        const payload = { command, admission, atEpochMs: this.config.now() };
        return decodeGroupMoveIngress({
            ...payload,
            authorityProof: await createGroupMutationAuthorityProof(session, payload)
        });
    }

    async read(value: unknown, attempt: AppInboxCommandAttempt): Promise<GroupMoveService.Read> {
        const ingress = decodeGroupMoveIngress(value);
        const { command } = ingress;
        const nowEpochMs = this.config.now();
        const actor = await this.readActor(ingress, nowEpochMs);
        const previous = await this.dependencies.moves.find(command);
        const pending = previous === null || previous.value.move.status === 'proposed';
        const source = pending
            ? computeGroupMoveSource(
                await this.dependencies.groups.readPresenceSummaryEntries(command.source),
                nowEpochMs
            )
            : null;
        const participants = previous?.value.move.participants ??
            source?.snapshot.members.filter((member) => member.status === 'active' && member.role !== 'spectator') ??
            [];
        const storage = await this.dependencies.moves.read({ ...command, participants });
        if (
            previous?.entry.revision !== storage.record?.entry.revision ||
            previous?.entry.value !== storage.record?.entry.value
        ) {
            throw new RuntimeStateWriteConflictError();
        }
        const selected = previous?.value.move.participants ??
            source?.snapshot.activeSessions.filter((session) =>
                participants.some((participant) => participant.principalId === session.principalId)
            ) ?? [];
        const { sessions, participantAuthorityLive } = await this.readParticipantAuthority(
            actor,
            pending ? selected : [],
            nowEpochMs
        );
        const admissions = await this.readAdmissions(
            command,
            previous?.value ?? null,
            participantAuthorityLive,
            attempt,
            nowEpochMs
        );
        return {
            ingress,
            traceId: attempt.traceId,
            nowEpochMs,
            storage,
            source,
            sessions,
            participantAuthorityLive,
            admissions
        };
    }

    private async readActor(
        ingress: GroupMoveIngress,
        nowEpochMs: number
    ): Promise<RuntimeStateEntryValue<PersistedAuthSession>> {
        const { command } = ingress;
        const actor = await this.dependencies.authSessions.findSessionBySessionIdEntry(command.actorSessionId);
        verifyLiveGroupMutationSession(ingress.authorityProof, actor?.value, nowEpochMs);
        if (!actor) {
            throw new GroupMutationAuthorizationError('Group move actor is missing');
        }
        const expected = await createGroupMutationAuthorityProof(actor.value, {
            command,
            admission: ingress.admission,
            atEpochMs: ingress.atEpochMs
        });
        if (!constantTimeHexEqual(expected.commandMac, ingress.authorityProof.commandMac)) {
            throw new GroupMutationAuthorizationError('Group move proof differs');
        }
        return actor;
    }

    private async readParticipantAuthority(
        actor: RuntimeStateEntryValue<PersistedAuthSession>,
        selected: readonly Pick<GroupMove['participants'][number], 'principalId' | 'sessionId'>[],
        nowEpochMs: number
    ) {
        const sessions = [actor];
        let participantAuthorityLive = true;
        for (const participant of selected) {
            const stored = participant.sessionId === actor.value.sessionId
                ? actor
                : await this.dependencies.authSessions.findSessionBySessionIdEntry(participant.sessionId);
            if (
                !stored || stored.value.clientId !== participant.principalId ||
                stored.value.expiresAtEpochMs <= nowEpochMs
            ) {
                participantAuthorityLive = false;
            }
            else if (stored.value.sessionId !== actor.value.sessionId) {
                sessions.push(stored);
            }
        }
        return { sessions, participantAuthorityLive };
    }

    private async readAdmissions(
        command: GroupMoveCommand,
        previous: GroupMoveRecord | null,
        participantAuthorityLive: boolean,
        attempt: AppInboxCommandAttempt,
        nowEpochMs: number
    ): Promise<GroupMoveAdmissionParticipant[]> {
        const admissions: GroupMoveAdmissionParticipant[] = [];
        if (
            command.action === 'commit' && previous?.move.status === 'proposed' && participantAuthorityLive &&
            nowEpochMs < previous.move.expiresAtEpochMs &&
            previous.move.participants.every((participant) => participant.confirmedAtEpochMs !== null)
        ) {
            for (const participant of previous.move.participants) {
                const evidence = previous.credentials.find((credential) =>
                    credential.sessionId === participant.sessionId
                )?.admission;
                if (!evidence || evidence.command.operation !== 'joinGroup') {
                    throw new TypeError('Confirmed participant admission evidence is missing');
                }
                const facts = toGroupMutationAttemptFacts({
                    ingressFacts: evidence.facts,
                    attemptCount: attempt.attemptCount,
                    laneNowEpochMs: nowEpochMs,
                    traceId: attempt.traceId
                });
                const read = await this.dependencies.mutations.read({ ...evidence, facts });
                const targetAdmission = await this.dependencies.groups.findPresenceAdmissionEntry({
                    ...command.destination,
                    principalId: participant.principalId
                });
                admissions.push({
                    command: evidence.command,
                    facts,
                    read: { ...read, targetAdmission: targetAdmission ?? null }
                });
            }
        }
        return admissions;
    }

    compute(read: GroupMoveService.Read): Either<GroupMoveRejection, GroupMoveService.Computed> {
        const { command } = read.ingress;
        const previous = read.storage.record?.value ?? null;
        if (!previous && !read.participantAuthorityLive) {
            return Either.ofLeft({
                code: 'group-move-rejected',
                message: 'A source player no longer has a live authenticated session.'
            });
        }
        const input = {
            proposal: previous?.move ?? null,
            source: read.participantAuthorityLive ? read.source?.snapshot ?? null : null,
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
        const admission = transition.right?.status === 'committed' && previous?.move.status === 'proposed'
            ? computeGroupMoveAdmission({ participants: read.admissions })
            : null;
        const decision = admission === null ? transition : computeGroupMove({ ...input, admission });
        return decision.flatMap<GroupMoveRejection, GroupMoveService.Computed>(
            Either.ofLeft,
            (result) => this.computeWrite(read, result, admission)
        );
    }

    private computeWrite(
        read: GroupMoveService.Read,
        result: GroupMove,
        admission: ReturnType<typeof computeGroupMoveAdmission> | null
    ): Either<GroupMoveRejection, GroupMoveService.Computed> {
        const record = this.nextRecord(read, result);
        const prepared = computeGroupMoveStorage({
            read: read.storage,
            record,
            terminalRetentionMs: this.config.finishedRetentionMs
        });
        return prepared.mapRight((storage) => this.computeEffects(read, result, admission, storage));
    }

    private computeEffects(
        read: GroupMoveService.Read,
        result: GroupMove,
        admission: ReturnType<typeof computeGroupMoveAdmission> | null,
        prepared: RuntimeStateGuardedBatchWrite
    ): GroupMoveService.Computed {
        const publication = computeGroupMovePublication({
            move: result,
            revision: (read.storage.record?.entry.revision ?? -1) + 1,
            createdAtEpochMs: read.nowEpochMs,
            retentionMs: this.config.finishedRetentionMs,
            serviceId: this.config.serviceId,
            traceId: read.traceId,
            scheduleDeadline: read.storage.record === null
        });
        const storage = computeRuntimeStateGuardedBatchWrite({
            ...prepared,
            effects: [...prepared.effects, ...publication.provenance]
        });
        const authEffects = read.sessions.map((stored): RuntimeStateGuardedBatchEffect => ({
            effectId: `auth:${stored.value.sessionId}`,
            operation: 'update',
            namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            key: stored.entry.key,
            value: stored.entry.value,
            expireAtTimestamp: stored.entry.expireAtTimestamp,
            expectedRevision: stored.entry.revision
        }));
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

    validate(read: GroupMoveService.Read, computed: Either<GroupMoveRejection, GroupMoveService.Computed>) {
        return validateComputedEitherProjection(this.compute(read), computed, 'group move');
    }

    /** AppInbox transaction callback: translate CAS outcomes here so partial writes roll back. */
    async write(transaction: PSqlSql, computed: GroupMoveService.Computed): Promise<void> {
        if (computed.authority !== null) {
            if (await writeGroupMoveStorage(transaction, computed.authority) === 'conflict') {
                throw new RuntimeStateWriteConflictError();
            }
        }
        if (await writeGroupMoveStorage(transaction, computed.storage) === 'conflict') {
            throw new RuntimeStateWriteConflictError();
        }
        for (const admission of computed.admissions) {
            await writeGroupMutation(transaction, admission);
        }
        for (const outbox of computed.outbox) {
            await writeAppOutboxInsert(transaction, outbox);
        }
    }

    async readExpiry(value: unknown, traceId: string): Promise<GroupMoveService.ExpiryRead> {
        const command = decodeGroupMoveDeadline(value);
        const previous = await this.dependencies.moves.find(command);
        return {
            command,
            traceId,
            nowEpochMs: this.config.now(),
            storage: previous === null ? null : await this.dependencies.moves.read(previous.value.move)
        };
    }

    computeExpiry(read: GroupMoveService.ExpiryRead): GroupMoveService.ExpiryComputed {
        const previous = read.storage?.record?.value;
        if (
            !previous || previous.move.status !== 'proposed' ||
            previous.move.expiresAtEpochMs !== read.command.expiresAtEpochMs
        ) {
            return { result: previous?.move ?? null, mutation: null };
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
            terminalRetentionMs: this.config.finishedRetentionMs
        });
        const prepared = storage.fold((rejection) => {
            throw new TypeError(`Expiry claim invariant: ${rejection.message}`);
        }, (value) => value);
        const publication = computeGroupMovePublication({
            move: result,
            revision: read.storage!.record!.entry.revision + 1,
            createdAtEpochMs: read.nowEpochMs,
            retentionMs: this.config.finishedRetentionMs,
            serviceId: this.config.serviceId,
            traceId: read.traceId,
            scheduleDeadline: false
        });
        return {
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

    validateExpiry(read: GroupMoveService.ExpiryRead, computed: GroupMoveService.ExpiryComputed) {
        return validateComputedProjection(this.computeExpiry(read), computed, 'group move expiry');
    }

    async writeExpiry(transaction: PSqlSql, computed: GroupMoveService.ExpiryComputed): Promise<void> {
        if (computed.mutation !== null) {
            await this.write(transaction, computed.mutation);
        }
    }

    private nextRecord(read: GroupMoveService.Read, move: GroupMove): GroupMoveRecord {
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
}

function admissionAuthority(
    participants: readonly GroupMoveAdmissionParticipant[],
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
