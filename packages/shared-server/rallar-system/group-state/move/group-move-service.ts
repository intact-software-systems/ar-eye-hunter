import { GROUP_MOVE_PROPOSAL_TTL_MS, type GroupMove, type GroupMoveRequest } from '@shared/api/mutation/group-move.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { PartyRepository } from '../../parties/persistence/party-repository.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type {
    RuntimeStateGuardedBatchWrite
} from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { AppInboxCommandAttempt } from '../../app-inbox/app-inbox-contracts.ts';
import { writeAppOutboxInserts, type AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import type { AuthSessionPersistence } from '../../auth/persistence/auth-session-persistence.ts';
import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import type { PersistedAuthSession } from '../../auth/persistence/persisted-auth-session.ts';
import {
    writeGuardedViewPublication,
    type GuardedViewPublication
} from '../../websocket/outbox/guarded-view-publication.ts';
import {
    createGroupMutationAuthorityProof,
    GroupMutationAuthorizationError,
    mutationDescriptor,
    verifyLiveGroupMutationSession
} from '../group-mutation-authority.ts';
import type { GroupStateService } from '../group-state-service-contracts.ts';
import { type GroupMutationComputedWrite } from '../mutation/group-mutation-contracts.ts';
import { constantTimeHexEqual } from '../mutation/group-state-crypto.ts';
import type { GroupCohortAdmissionParticipant } from '../mutation/membership/compute-group-cohort-admission.ts';
import { toGroupMutationAttemptFacts } from '../mutation/to-group-mutation-attempt-facts.ts';
import { writeGroupMutation } from '../mutation/write/write-group-mutation.ts';
import type { GroupStateRepository } from '../persistence/group-state-repository.ts';
import type { GroupMoveAdmissionResult } from './compute-group-move-admission.ts';
import { computeGroupMoveSource, type GroupMoveSource } from './compute-group-move-source.ts';
import type { GroupMoveRecord } from './group-move-codec.ts';
import {
    decodeGroupMoveCommand,
    decodeGroupMoveIngress,
    decodeGroupMoveRequest,
    type GroupMoveCommand,
    type GroupMoveIngress
} from './group-move-command.ts';
import type { GroupMoveDeadline } from './group-move-deadline.ts';
import { GroupMoveRepository, writeGroupMoveStorage } from './group-move-repository.ts';

export namespace GroupMoveService {
    export interface Dependencies {
        readonly groups: GroupStateRepository;
        readonly moves: GroupMoveRepository;
        readonly parties: PartyRepository;
        readonly authSessions: AuthSessionPersistence;
        readonly mutations: Pick<GroupStateService, 'captureMutationIngress' | 'read'>;
    }
    export interface Config {
        readonly serviceId: string;
        readonly finishedRetentionMs: number;
        readonly now: () => number;
    }
    export interface Read {
        readonly serviceId: string;
        readonly finishedRetentionMs: number;
        readonly ingress: GroupMoveIngress;
        readonly traceId: string;
        readonly nowEpochMs: number;
        readonly storage: GroupMoveRepository.Read;
        readonly source: GroupMoveSource | null;
        readonly party: PartyRepository.Read | null;
        readonly sessions: readonly RuntimeStateEntryValue<PersistedAuthSession>[];
        readonly participantAuthorityLive: boolean;
        readonly admissions: readonly GroupCohortAdmissionParticipant[];
    }
    export interface ExpiryRead {
        readonly serviceId: string;
        readonly finishedRetentionMs: number;
        readonly command: GroupMoveDeadline;
        readonly traceId: string;
        readonly nowEpochMs: number;
        readonly storage: GroupMoveRepository.Read | null;
    }
    export type ExpiryComputed =
        | { readonly kind: 'proposal-expiry'; readonly result: GroupMove | null; readonly mutation: Computed | null; }
        | { readonly kind: 'terminal-retention'; readonly result: null; readonly publication: GuardedViewPublication; };
    export interface AdmissionInput {
        readonly command: GroupMoveCommand;
        readonly previous: GroupMoveRecord | null;
        readonly participantAuthorityLive: boolean;
        readonly attempt: AppInboxCommandAttempt;
        readonly nowEpochMs: number;
    }
    export interface EffectsInput {
        readonly read: Read;
        readonly result: GroupMove;
        readonly admission: GroupMoveAdmissionResult | null;
        readonly prepared: RuntimeStateGuardedBatchWrite;
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

    async read(ingress: GroupMoveIngress, attempt: AppInboxCommandAttempt): Promise<GroupMoveService.Read> {
        const { command } = ingress;
        const nowEpochMs = this.config.now();
        const actor = await this.readActor(ingress, nowEpochMs);
        const previous = await this.dependencies.moves.find(command);
        if (previous !== null && !jsonEquals(previous.value.move.party ?? null, command.party ?? null)) {
            throw new TypeError('Group move party selection differs from its proposal');
        }
        const pending = previous === null || previous.value.move.status === 'proposed';
        const { source, party } = await this.readSourceAuthority(command, pending, nowEpochMs);
        const participants = previous?.value.move.participants ??
            source?.snapshot.members.filter((member) =>
                member.status === 'active' && member.role !== 'spectator' &&
                (command.party === undefined ||
                    party?.record?.members.some((selected) => selected.principalId === member.principalId))
            ) ??
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
        const admissions = await this.readAdmissions({
            command,
            previous: previous?.value ?? null,
            participantAuthorityLive,
            attempt,
            nowEpochMs
        });
        return {
            ingress,
            serviceId: this.config.serviceId,
            finishedRetentionMs: this.config.finishedRetentionMs,
            traceId: attempt.traceId,
            nowEpochMs,
            storage,
            source,
            party,
            sessions,
            participantAuthorityLive,
            admissions
        };
    }

    private async readSourceAuthority(
        command: GroupMoveCommand,
        pending: boolean,
        nowEpochMs: number
    ): Promise<Pick<GroupMoveService.Read, 'source' | 'party'>> {
        const source = pending
            ? computeGroupMoveSource(
                await this.dependencies.groups.readPresenceSummaryEntries(command.source),
                nowEpochMs
            )
            : null;
        const party = pending && command.party !== undefined
            ? await this.dependencies.parties.read({
                applicationId: command.source.applicationId,
                workspaceId: command.source.workspaceId,
                partyId: command.party.partyId
            })
            : null;
        return { source, party };
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
    ): Promise<Pick<GroupMoveService.Read, 'sessions' | 'participantAuthorityLive'>> {
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
        { command, previous, participantAuthorityLive, attempt, nowEpochMs }: GroupMoveService.AdmissionInput
    ): Promise<GroupCohortAdmissionParticipant[]> {
        if (
            command.action !== 'commit' || previous?.move.status !== 'proposed' || !participantAuthorityLive ||
            nowEpochMs >= previous.move.expiresAtEpochMs ||
            previous.move.participants.some((participant) => participant.confirmedAtEpochMs === null)
        ) {
            return [];
        }
        const admissions: GroupCohortAdmissionParticipant[] = [];
        for (const participant of previous.move.participants) {
            const evidence = previous.credentials.find((credential) => credential.sessionId === participant.sessionId)
                ?.admission;
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
        return admissions;
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
        await writeAppOutboxInserts(transaction, computed.outbox);
    }

    async readExpiry(command: GroupMoveDeadline, traceId: string): Promise<GroupMoveService.ExpiryRead> {
        const previous = 'expiresAtEpochMs' in command ? await this.dependencies.moves.find(command) : null;
        const matches = previous !== null && 'expiresAtEpochMs' in command &&
            previous.value.move.createdAtEpochMs === command.expiresAtEpochMs - GROUP_MOVE_PROPOSAL_TTL_MS;
        return {
            command,
            serviceId: this.config.serviceId,
            finishedRetentionMs: this.config.finishedRetentionMs,
            traceId,
            nowEpochMs: this.config.now(),
            storage: matches ? await this.dependencies.moves.read(previous.value.move) : null
        };
    }

    async writeExpiry(transaction: PSqlSql, computed: GroupMoveService.ExpiryComputed): Promise<void> {
        if (computed.kind === 'terminal-retention') {
            await writeGuardedViewPublication(transaction, computed.publication);
        }
        else if (computed.mutation !== null) {
            await this.write(transaction, computed.mutation);
        }
    }
}
