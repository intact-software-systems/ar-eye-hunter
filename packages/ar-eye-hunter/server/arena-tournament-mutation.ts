import {
    computeRoomOwnedAppDataSave,
    writeRoomOwnedAppData,
    type RoomOwnedAppData
} from '@shared-server/app-data/room-owned-app-data.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import {
    writeAppOutboxInserts,
    type AppOutboxInsert
} from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import type { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import {
    AUTH_SESSIONS_BY_SESSION_NAMESPACE,
    authSessionKey
} from '@shared-server/rallar-system/auth/persistence/auth-storage-keys.ts';
import type { PersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/persisted-auth-session.ts';
import {
    validateComputedProjection,
    type ComputedDataValidationIssue
} from '@shared-server/rallar-system/computed-data-validation.ts';
import {
    computeObservedGroupAuthority,
    writeObservedGroupAuthority,
    type ObservedGroupAuthority
} from '@shared-server/rallar-system/group-state/persistence/aggregate/observed-group-authority.ts';
import type { GroupStateAuthoritativeSnapshot } from '@shared-server/rallar-system/group-state/persistence/group-state-persistence-contracts.ts';
import type { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { SESSIONS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { groupStatePresenceSessionStorageKey } from '@shared-server/rallar-system/group-state/persistence/presence/group-presence-storage-keys.ts';
import { canSendGroupMessage } from '@shared-server/rallar-system/group-state/policy/group-message-policy.ts';
import { decodeJsonWireText } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import {
    computeTournamentAttemptFence,
    computeTournamentResultPublication,
    writeTournamentGame,
    type TournamentResultRepository
} from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import { createTournamentResult } from '@shared-server/rallar-system/tournaments/tournament-result.ts';
import {
    computeTournamentSignal,
    TOURNAMENT_SIGNAL_RETENTION_MS
} from '@shared-server/rallar-system/tournaments/tournament-signal.ts';
import {
    writeRuntimeStateConditionalBatch,
    type RuntimeStateConditionalBatch
} from '@shared-server/runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import type { RuntimeStateEntryRead } from '@shared-server/runtime-state/runtime-state-json-store.ts';
import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import type { GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';
import { assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import { decodeStateScope } from '@shared/api/state-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { AR_EYE_TOURNAMENT_RULES_ID } from '../tournament-arena.ts';
import {
    advanceTournamentArena,
    applyTournamentArenaInput,
    createTournamentArena,
    decodeTournamentArenaInput,
    type TournamentArena,
    type TournamentArenaInput
} from '../tournament-arena.ts';
import { ARENA_TOURNAMENT_FINISH_TOPIC, computeArenaTournamentDeadline } from './arena-tournament-deadline.ts';
import { readArenaTournamentRoom, toTournamentArenaIdentity } from './arena-tournament-room.ts';

export namespace ArenaTournamentMutation {
    export interface Actor {
        readonly principalId: string;
        readonly sessionId: string;
        readonly issuedAtEpochMs: number;
    }

    export type Command =
        & {
            readonly roomRef: GroupRef;
            readonly requestId: string;
            readonly capturedAtEpochMs: number;
        }
        & (
            | { readonly kind: 'input'; readonly actor: Actor; readonly input: TournamentArenaInput; }
            | { readonly kind: 'tick'; readonly actor: null; readonly input: null; }
        );

    export interface Room {
        readonly group: GroupStateAuthoritativeSnapshot | null;
        readonly tournament: TournamentResultRepository.Read | null;
        readonly save: RoomOwnedAppData.Read;
        readonly state: TournamentArena | null;
    }

    export interface Read extends Room {
        readonly command: Command;
        readonly traceId: string;
        readonly nowEpochMs: number;
        readonly serverId: string;
        readonly session: RuntimeStateEntryRead<PersistedAuthSession> | null;
        readonly presence: RuntimeStateEntryRead<GroupPresenceSession> | null;
    }

    export interface Result {
        readonly status: 'applied' | 'refused';
        readonly roomRef: GroupRef;
        readonly reason: string | null;
        readonly simulatedAtEpochMs: number | null;
        readonly complete: boolean;
    }

    export interface Computed {
        readonly result: Result;
        readonly outbox: readonly AppOutboxInsert[];
        readonly groupGuard: ObservedGroupAuthority | null;
        readonly save: RoomOwnedAppData.Write | null;
        readonly attemptWrite: RuntimeStateConditionalBatch | null;
        readonly resultWrite: TournamentResultRepository.Write | null;
    }

    export interface Dependencies {
        readonly groups: Pick<GroupStateRepository, 'readSnapshotWithAuthorityGuard' | 'readPresenceEntry'>;
        readonly sessions: Pick<AuthSessionPersistence, 'readSessionBySessionIdEntry'>;
        readonly results: Pick<TournamentResultRepository, 'readRoom'>;
        readonly data: Pick<RoomOwnedAppData, 'read'>;
    }

    export interface Config {
        readonly nowEpochMs: () => number;
        readonly serverId: string;
    }
}

/** One read/compute/validate/write attempt. The application AppInbox owns admission, transaction and retry. */
export class ArenaTournamentMutation {
    private readonly dependencies: ArenaTournamentMutation.Dependencies;
    private readonly config: ArenaTournamentMutation.Config;

    constructor(dependencies: ArenaTournamentMutation.Dependencies, config: ArenaTournamentMutation.Config) {
        this.dependencies = dependencies;
        this.config = config;
    }

    async read(value: ArenaTournamentMutation.Command, traceId: string): Promise<ArenaTournamentMutation.Read> {
        const command = decodeArenaTournamentCommand(value);
        const ref = command.roomRef;
        const [room, session, presence] = await Promise.all([
            readArenaTournamentRoom(this.dependencies, ref),
            command.actor === null
                ? null
                : this.dependencies.sessions.readSessionBySessionIdEntry(command.actor.sessionId),
            command.actor === null
                ? null
                : this.dependencies.groups.readPresenceEntry({ ...ref, sessionId: command.actor.sessionId })
        ]);
        return {
            ...room,
            command,
            traceId,
            nowEpochMs: Math.max(command.capturedAtEpochMs, this.config.nowEpochMs()),
            serverId: this.config.serverId,
            session,
            presence
        };
    }

    compute(read: ArenaTournamentMutation.Read): ArenaTournamentMutation.Computed {
        return computeArenaTournamentMutation(read);
    }

    validate(
        read: ArenaTournamentMutation.Read,
        computed: ArenaTournamentMutation.Computed
    ): readonly ComputedDataValidationIssue[] {
        return validateComputedProjection(computeArenaTournamentMutation(read), computed, 'arena-tournament');
    }

    async write(transaction: PSqlSql, computed: ArenaTournamentMutation.Computed): Promise<void> {
        if (computed.groupGuard !== null) {
            await writeObservedGroupAuthority(transaction, computed.groupGuard);
        }
        if (computed.save !== null) {
            await writeRoomOwnedAppData(transaction, computed.save);
        }
        if (computed.attemptWrite !== null) {
            await writeRuntimeStateConditionalBatch(transaction, computed.attemptWrite);
        }
        if (computed.resultWrite !== null) {
            await writeTournamentGame(transaction, computed.resultWrite);
        }
        await writeAppOutboxInserts(transaction, computed.outbox);
    }
}

export function decodeArenaTournamentCommand(value: unknown): ArenaTournamentMutation.Command {
    const command = requireRecord(value, 'Arena tournament command');
    requireExactKeys(
        command,
        ['kind', 'roomRef', 'requestId', 'actor', 'input', 'capturedAtEpochMs'],
        'Arena tournament command'
    );
    const room = requireRecord(command.roomRef, 'Arena tournament room');
    requireExactKeys(room, ['applicationId', 'workspaceId', 'groupId'], 'Arena tournament room');
    const scope = decodeStateScope({ applicationId: room.applicationId, workspaceId: room.workspaceId });
    requireString(room.groupId, 'Arena tournament group');
    requireString(command.requestId, 'Arena tournament request');
    requireEpoch(command.capturedAtEpochMs, 'Arena tournament capture');
    const kind = requireOneOf(command.kind, ['input', 'tick'], 'Arena tournament operation');
    const base = {
        roomRef: { ...scope, groupId: assertValidRallarRouteId(room.groupId) },
        requestId: assertValidRallarRouteId(command.requestId),
        capturedAtEpochMs: command.capturedAtEpochMs
    };
    if (kind === 'tick') {
        if (command.actor !== null || command.input !== null) {
            throw new TypeError('Server ticks cannot carry a client input');
        }
        return { ...base, kind, actor: null, input: null };
    }
    const actor = requireRecord(command.actor, 'Arena tournament actor');
    requireExactKeys(actor, ['principalId', 'sessionId', 'issuedAtEpochMs'], 'Arena tournament actor');
    requireString(actor.principalId, 'Arena tournament account');
    requireString(actor.sessionId, 'Arena tournament session');
    requireEpoch(actor.issuedAtEpochMs, 'Arena tournament session issuance');
    return {
        ...base,
        kind,
        actor: { principalId: actor.principalId, sessionId: actor.sessionId, issuedAtEpochMs: actor.issuedAtEpochMs },
        input: decodeTournamentArenaInput(command.input)
    };
}

function computeArenaTournamentMutation(read: ArenaTournamentMutation.Read): ArenaTournamentMutation.Computed {
    const denial = authorizeTournamentMutation(read);
    if (denial !== null) {
        return withoutWrite(read, 'refused', denial);
    }
    const tournament = read.tournament!;
    if (tournament.attempt?.status === 'finished') {
        return withoutWrite(read, 'applied', null);
    }
    const previous = read.state ?? createTournamentArena(toTournamentArenaIdentity(tournament));
    const transition = read.command.kind === 'input'
        ? applyTournamentArenaInput({
            state: previous,
            principalId: read.command.actor.principalId,
            input: read.command.input,
            nowEpochMs: read.nowEpochMs
        })
        : { accepted: true, reason: 'accepted', state: advanceTournamentArena(previous, read.nowEpochMs) };
    const state = transition.state;
    const resultWrite = computeArenaResultWrite(read, state);
    return {
        result: {
            status: transition.accepted ? 'applied' : 'refused',
            roomRef: read.command.roomRef,
            reason: transition.accepted ? null : transition.reason,
            simulatedAtEpochMs: state.simulatedAtEpochMs,
            complete: state.arena.match?.status === 'complete'
        },
        outbox: computeArenaTournamentDeadline(read, state),
        groupGuard: computeArenaAuthority(read),
        save: computeRoomOwnedAppDataSave({
            read: read.save,
            value: decodeJsonWireText(JSON.stringify({ binding: tournament.binding, state })),
            schemaVersion: 1,
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        }),
        attemptWrite: resultWrite === null ? computeTournamentAttemptFence(tournament, 'playing') : null,
        resultWrite
    };
}

function authorizeTournamentMutation(read: ArenaTournamentMutation.Read): string | null {
    const tournament = read.tournament;
    const group = read.group?.snapshot;
    if (
        !tournament || !group || group.group.status !== 'active' ||
        group.group.expiresAtEpochMs !== null && group.group.expiresAtEpochMs <= read.nowEpochMs
    ) {
        return 'room-unavailable';
    }
    if (tournament.binding.rulesId !== AR_EYE_TOURNAMENT_RULES_ID) {
        return 'unsupported-rules';
    }
    if (tournament.attempt?.status === 'finished' && read.command.kind === 'tick' && read.state !== null) {
        return null;
    }
    if (
        tournament.attempt?.status !== 'playing' || tournament.attempt.startedAtEpochMs === null ||
        tournament.attempt.startedAtEpochMs > read.nowEpochMs
    ) {
        return 'inactive-attempt';
    }
    if (
        tournament.binding.principalIds.some((principalId) =>
            !group.members.some((member) =>
                member.principalId === principalId && member.status === 'active' && member.role !== 'spectator'
            )
        )
    ) {
        return 'competitor-unavailable';
    }
    if (read.command.kind === 'tick') {
        return null;
    }
    const actor = read.command.actor;
    const session = read.session?.value?.value;
    if (
        !session || session.clientId !== actor.principalId || session.sessionId !== actor.sessionId ||
        session.issuedAtEpochMs !== actor.issuedAtEpochMs || session.expiresAtEpochMs <= read.nowEpochMs
    ) {
        return 'invalid-session';
    }
    if (!tournament.binding.principalIds.includes(actor.principalId)) {
        return 'not-a-competitor';
    }
    const presence = read.presence?.value?.value;
    const activeSessions = [
        ...group.activeSessions.filter((entry) => entry.sessionId !== actor.sessionId),
        ...(presence === undefined ? [] : [presence])
    ];
    const policy = canSendGroupMessage({
        snapshot: { ...group, activeSessions },
        actor,
        senderSessionId: actor.sessionId,
        nowEpochMs: read.nowEpochMs
    });
    return policy.allowed ? null : policy.code;
}

function withoutWrite(
    read: ArenaTournamentMutation.Read,
    status: ArenaTournamentMutation.Result['status'],
    reason: string | null
): ArenaTournamentMutation.Computed {
    return {
        result: {
            status,
            roomRef: read.command.roomRef,
            reason,
            simulatedAtEpochMs: read.state?.simulatedAtEpochMs ?? null,
            complete: read.state?.arena.match?.status === 'complete'
        },
        outbox: [],
        groupGuard: null,
        save: null,
        attemptWrite: null,
        resultWrite: null
    };
}

function computeArenaAuthority(read: ArenaTournamentMutation.Read): ObservedGroupAuthority {
    const actor = read.command.actor;
    return computeObservedGroupAuthority({
        group: read.group!,
        observations: actor === null ? [] : [
            {
                namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE,
                key: authSessionKey(actor.sessionId),
                entry: read.session?.value?.entry ?? read.session?.expiredEntry ?? null
            },
            {
                namespace: SESSIONS_NAMESPACE,
                key: groupStatePresenceSessionStorageKey({ ...read.command.roomRef, sessionId: actor.sessionId }),
                entry: read.presence?.value?.entry ?? read.presence?.expiredEntry ?? null
            }
        ]
    });
}

function computeArenaResultWrite(
    read: ArenaTournamentMutation.Read,
    state: TournamentArena
): TournamentResultRepository.Write | null {
    if (state.arena.match?.status !== 'complete') {
        return null;
    }
    const tournament = read.tournament!;
    const scores = tournament.binding.principalIds.map((principalId) =>
        state.players.find((player) => player.principalId === principalId)!.simulation.combat.score
    );
    const result = createTournamentResult({
        binding: tournament.binding,
        authority: { kind: 'server', id: read.serverId, epoch: 1 },
        startedAtEpochMs: state.startedAtEpochMs,
        finishedAtEpochMs: state.endsAtEpochMs,
        scores: [scores[0], scores[1]]
    });
    const publication = computeTournamentResultPublication(tournament, result, read.nowEpochMs);
    if (publication.kind !== 'publish') {
        throw new TypeError('Active arena completion has no new authorized result');
    }
    // Only the terminal transition persists a presentation wake; ordinary ticks persist just their existing successor.
    const wake = computeTournamentSignal({
        topic: ARENA_TOURNAMENT_FINISH_TOPIC,
        signal: { kind: 'result', binding: tournament.binding, dueAtEpochMs: read.nowEpochMs },
        createdAtEpochMs: read.nowEpochMs,
        serviceId: read.serverId,
        traceId: read.traceId,
        retentionMs: TOURNAMENT_SIGNAL_RETENTION_MS
    });
    return { ...publication.write, outbox: [...publication.write.outbox, wake] };
}
