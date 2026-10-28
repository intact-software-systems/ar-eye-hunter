import {
    computeRoomOwnedAppDataSave,
    writeRoomOwnedAppData,
    type RoomOwnedAppData
} from '@shared-server/app-data/room-owned-app-data.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { AppInboxCommandAttempt } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import {
    writeAppOutboxInserts,
    type AppOutboxInsert
} from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import type { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import type { PersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/persisted-auth-session.ts';
import {
    validateComputedProjection,
    type ComputedDataValidationIssue
} from '@shared-server/rallar-system/computed-data-validation.ts';
import { materializeGroupStateAuthorityGuard } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-repository.ts';
import type { GroupStateAuthoritativeSnapshot } from '@shared-server/rallar-system/group-state/persistence/group-state-persistence-contracts.ts';
import type { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { canUpdateGroupSnapshot } from '@shared-server/rallar-system/group-state/policy/group-governance-policy.ts';
import { canSendGroupMessage } from '@shared-server/rallar-system/group-state/policy/group-message-policy.ts';
import { canReadGroupSnapshot } from '@shared-server/rallar-system/group-state/policy/group-snapshot-visibility-policy.ts';
import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '@shared-server/rallar-system/protocol/exact-object-decoding.ts';
import { decodeJsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { Either } from '@shared/resilience/Either.ts';
import {
    applyRelicCommand,
    toPublicRelicSnapshot,
    toRelicRoomGroupRef,
    type RelicCommand,
    type RelicGameState,
    type RelicPublicSnapshot,
    type RelicRuleRefusal
} from '../mod.ts';
import { decodeRelicGameStateAppData } from './decode-relic-game-state-app-data.ts';
import { encodeRelicGameStateAppData } from './encode-relic-game-state-app-data.ts';
import {
    captureRelicGameMove,
    decodeRelicGameMove,
    toRelicCommand,
    type RelicGameMove
} from './relic-game-move.ts';

import {
    computeRelicGamePublications,
    writeRelicGameProvenance,
    type RelicGamePublicationProvenance
} from './compute-relic-game-publications.ts';

const relicScope = toRelicRoomGroupRef('scope');
export const RELIC_ROOM_DATA_BINDING: RoomOwnedAppData.Binding = {
    applicationId: relicScope.applicationId,
    workspaceId: relicScope.workspaceId,
    namespace: 'relic-hunter-v1',
    storeName: 'relic-hunter-games'
};

export namespace RelicGameMutationService {
    /** The transport's command: its trace rides the admitted envelope, never the captured command. */
    export interface CommandInput {
        readonly operation: 'ensure' | 'reset' | 'command';
        readonly gameId: string;
        readonly requestId: string;
        readonly traceId: string;
        readonly actor: Readonly<{ clientId: string; sessionId: string; issuedAtEpochMs: number; }>;
        readonly authorization: 'authenticated' | 'group-policy';
        readonly move: RelicCommand | null;
    }

    export interface Command extends Omit<CommandInput, 'move' | 'traceId'> {
        readonly move: RelicGameMove | null;
    }

    export interface Ingress {
        readonly command: Command;
        readonly initial: RelicGameState | null;
        readonly capturedAtEpochMs: number;
        readonly serverPeerId: string;
    }

    export interface Read {
        readonly ingress: Ingress;
        readonly attemptAtEpochMs: number;
        readonly session: PersistedAuthSession | null;
        readonly group: GroupStateAuthoritativeSnapshot | null;
        readonly save: RoomOwnedAppData.Read;
    }

    export interface Attempt extends Read, AppInboxCommandAttempt {}

    export interface RefusalReason {
        readonly code: string;
        readonly message: string;
        readonly httpStatus: 401 | 403 | 404 | 409;
    }

    export interface Refusal extends RefusalReason {
        readonly status: 'refused';
        readonly gameId: string;
    }

    export type Result =
        | Readonly<{ status: 'initialized'; gameId: string; }>
        | Readonly<{ status: 'applied'; gameId: string; }>
        | Refusal;

    export interface GroupGuard {
        readonly namespace: string;
        readonly key: string;
        readonly value: string;
        readonly expectedRevision: number;
        readonly expireAtIso: string;
    }

    export interface Computed {
        readonly result: Result;
        readonly guard: GroupGuard | null;
        readonly save: RoomOwnedAppData.Write | null;
        readonly outboxWrites: readonly AppOutboxInsert[];
        readonly provenance: readonly RelicGamePublicationProvenance[];
    }

    export interface Dependencies {
        readonly groups: Pick<GroupStateRepository, 'readSnapshotWithAuthorityGuard'>;
        readonly sessions: Pick<AuthSessionPersistence, 'findBySessionId'>;
        readonly data: Pick<RoomOwnedAppData, 'read'>;
    }

    export interface Config {
        readonly now: () => number;
    }
}

/** One authoritative expedition mutation attempt. AppInbox owns completion, transaction and retry. */
export class RelicGameMutationService {
    private readonly dependencies: RelicGameMutationService.Dependencies;
    private readonly config: RelicGameMutationService.Config;

    constructor(dependencies: RelicGameMutationService.Dependencies, config: RelicGameMutationService.Config) {
        this.dependencies = dependencies;
        this.config = config;
    }

    capture(
        command: RelicGameMutationService.Command,
        initial: RelicGameState | null,
        serverPeerId: string
    ): RelicGameMutationService.Ingress {
        return decodeRelicGameIngress({
            command,
            initial: initial === null ? null : encodeRelicGameStateAppData(initial),
            serverPeerId,
            capturedAtEpochMs: this.config.now()
        });
    }

    async read(value: RelicGameMutationService.Ingress): Promise<RelicGameMutationService.Read> {
        const ingress = decodeRelicGameIngress({
            ...value,
            initial: value.initial === null ? null : encodeRelicGameStateAppData(value.initial)
        });
        const ref = toRelicRoomGroupRef(ingress.command.gameId);
        const [group, session, saves] = await Promise.all([
            this.dependencies.groups.readSnapshotWithAuthorityGuard(ref),
            this.dependencies.sessions.findBySessionId(ingress.command.actor.sessionId),
            this.dependencies.data.read(ref)
        ]);
        const save = saves.find(({ key }) =>
            key.namespace === RELIC_ROOM_DATA_BINDING.namespace &&
            key.storeName === RELIC_ROOM_DATA_BINDING.storeName && key.key === ref.groupId
        );
        if (save === undefined) {
            throw new TypeError('Relic room-owned AppData binding is missing');
        }
        return {
            ingress,
            group: group ?? null,
            session: session ?? null,
            save,
            attemptAtEpochMs: Math.max(this.config.now(), ingress.capturedAtEpochMs)
        };
    }

    needsInitialState(read: RelicGameMutationService.Read): boolean {
        return authorizeRelicGameMutation(read) === null &&
            (read.ingress.command.operation === 'reset' || read.save.entry === null);
    }

    async readCurrentSnapshot(
        command: RelicGameMutationService.CommandInput,
        serverPeerId: string
    ): Promise<RelicPublicSnapshot | null> {
        const read = await this.read(this.capture(captureRelicGameCommand(command), null, serverPeerId));
        const denial = authorizeRelicGameMutation(read, true);
        if (denial !== null) {
            throw new RelicGameMutationRefusedError(denial);
        }
        const entry = read.save.entry;
        return entry === null
            ? null
            : toPublicRelicSnapshot(decodeStoredRelicSave(entry.value, entry.schemaVersion, command.gameId));
    }

    async canRequestPlanning(sessionId: string, gameId: string, serverPeerId: string): Promise<boolean> {
        const session = await this.dependencies.sessions.findBySessionId(sessionId);
        if (!session) {
            return false;
        }
        const command: RelicGameMutationService.CommandInput = {
            operation: 'ensure',
            gameId,
            requestId: 'planning-authorization',
            traceId: 'planning-authorization',
            actor: { clientId: session.clientId, sessionId, issuedAtEpochMs: session.issuedAtEpochMs },
            authorization: 'group-policy',
            move: null
        };
        const read = await this.read(this.capture(captureRelicGameCommand(command), null, serverPeerId));
        if (authorizeRelicGameMutation(read) !== null || read.save.entry === null) {
            return false;
        }
        if (
            !read.group || !canSendGroupMessage({
                snapshot: read.group.snapshot,
                actor: { principalId: session.clientId, sessionId },
                senderSessionId: sessionId,
                nowEpochMs: read.attemptAtEpochMs
            }).allowed
        ) {
            return false;
        }
        const state = decodeStoredRelicSave(read.save.entry.value, read.save.entry.schemaVersion, gameId);
        return state.players.some((player) => player.playerId === sessionId);
    }

    compute(attempt: RelicGameMutationService.Attempt): RelicGameMutationService.Computed {
        return computeRelicGameMutation(attempt);
    }

    validate(
        attempt: RelicGameMutationService.Attempt,
        computed: RelicGameMutationService.Computed
    ): readonly ComputedDataValidationIssue[] {
        return validateComputedProjection(computeRelicGameMutation(attempt), computed, 'relic');
    }

    async write(transaction: PSqlSql, computed: RelicGameMutationService.Computed): Promise<void> {
        if (computed.guard !== null) {
            const guard = computed.guard;
            const rows = await transaction<{ revision: number; }[]>`
                update runtime_state_store
                set store_value = ${guard.value}, expire_at_ts = ${guard.expireAtIso}::timestamptz,
                    updated_ts = now(), revision = revision + 1
                where store_namespace = ${guard.namespace} and store_key = ${guard.key}
                  and revision = ${guard.expectedRevision}
                returning revision
            `;
            if (rows.length !== 1) {
                throw new RuntimeStateWriteConflictError();
            }
        }
        if (computed.save !== null) {
            await writeRoomOwnedAppData(transaction, computed.save);
        }
        await writeRelicGameProvenance(transaction, computed.provenance);
        await writeAppOutboxInserts(transaction, computed.outboxWrites);
    }
}

export class RelicGameMutationRefusedError extends Error {
    readonly result: RelicGameMutationService.Refusal;

    constructor(result: RelicGameMutationService.Refusal) {
        super(result.message);
        this.name = 'RelicGameMutationRefusedError';
        this.result = result;
    }
}

function authorizeRelicGameMutation(
    read: RelicGameMutationService.Read,
    readOnly = false
): RelicGameMutationService.Refusal | null {
    const { command } = read.ingress;
    const session = read.session;
    if (
        session === null || session.sessionId !== command.actor.sessionId ||
        session.clientId !== command.actor.clientId ||
        session.issuedAtEpochMs !== command.actor.issuedAtEpochMs || session.expiresAtEpochMs <= read.attemptAtEpochMs
    ) {
        return refusal(command, {
            code: 'invalid-session',
            message: 'The issued session is no longer active.',
            httpStatus: 401
        });
    }
    const group = read.group;
    if (
        group === null || group.snapshot.group.status !== 'active' ||
        (group.snapshot.group.expiresAtEpochMs !== null &&
            group.snapshot.group.expiresAtEpochMs <= read.attemptAtEpochMs)
    ) {
        return refusal(command, {
            code: 'room-unavailable',
            message: 'The expedition room is no longer available.',
            httpStatus: 404
        });
    }
    const member = group.snapshot.members.find((entry) => entry.principalId === session.clientId);
    if (member?.status !== 'active') {
        return refusal(command, {
            code: 'active-membership-required',
            message: 'An active room membership is required.',
            httpStatus: 403
        });
    }
    if (!readOnly && member.role === 'spectator') {
        return refusal(command, {
            code: 'spectator-read-only',
            message: 'Spectators cannot change an expedition.',
            httpStatus: 403
        });
    }
    if (readOnly || command.authorization === 'group-policy') {
        const input = {
            snapshot: group.snapshot,
            actor: { principalId: session.clientId, sessionId: session.sessionId },
            nowEpochMs: read.attemptAtEpochMs
        };
        const policy = readOnly ? canReadGroupSnapshot(input) : command.operation === 'reset'
            ? canUpdateGroupSnapshot(input)
            : command.operation === 'command'
            ? canSendGroupMessage({ ...input, senderSessionId: session.sessionId })
            : canReadGroupSnapshot(input);
        if (!policy.allowed) {
            return refusal(command, { code: policy.code, message: policy.message, httpStatus: 403 });
        }
    }
    return null;
}

function computeRelicGameMutation(read: RelicGameMutationService.Attempt): RelicGameMutationService.Computed {
    const { command } = read.ingress;
    const denial = authorizeRelicGameMutation(read);
    if (denial !== null) {
        return { result: denial, guard: null, save: null, outboxWrites: [], provenance: [] };
    }
    const group = read.group;
    const session = read.session;
    if (group === null || session === null) {
        throw new TypeError('Authorized Relic mutation lacks its room or session');
    }
    const previous = read.save.entry === null
        ? null
        : decodeStoredRelicSave(read.save.entry.value, read.save.entry.schemaVersion, command.gameId);
    const guard = computeRelicGameGroupGuard(group);
    if (command.operation === 'ensure' && previous !== null) {
        return {
            result: { status: 'initialized', gameId: command.gameId },
            guard,
            save: null,
            outboxWrites: [],
            provenance: []
        };
    }
    const initial = read.ingress.initial;
    if ((command.operation === 'reset' || previous === null) && initial === null) {
        return refused(command, {
            code: 'initial-state-missing',
            message: 'No captured expedition proposal is available.',
            httpStatus: 409
        });
    }
    const transition = computeRelicGameTransition(read, previous);
    if (transition.left !== undefined) {
        return {
            ...refused(command, { code: 'rule-refused', message: transition.left.message, httpStatus: 409 }),
            guard,
            ...computeRelicGamePublications({ read, previous, next: null, refusal: transition.left.message })
        };
    }
    const next = transition.right;
    if (next === undefined) {
        throw new TypeError('Relic transition lacks its result');
    }
    return {
        result: command.operation === 'ensure'
            ? { status: 'initialized', gameId: command.gameId }
            : { status: 'applied', gameId: command.gameId },
        guard,
        ...computeRelicGamePublications({ read, previous: previous ?? initial, next, refusal: null }),
        save: computeRoomOwnedAppDataSave({
            read: read.save,
            value: encodeRelicGameStateAppData(next),
            schemaVersion: 1,
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        })
    };
}

function computeRelicGameGroupGuard(group: GroupStateAuthoritativeSnapshot): RelicGameMutationService.GroupGuard {
    const authority = materializeGroupStateAuthorityGuard(group.authorityGuard);
    return {
        namespace: authority.namespace,
        key: authority.key,
        value: authority.value,
        expectedRevision: authority.expectedRevision,
        expireAtIso: new Date(authority.expireAtTimestamp).toISOString()
    };
}

function computeRelicGameTransition(
    read: RelicGameMutationService.Read,
    previous: RelicGameState | null
): Either<RelicRuleRefusal, RelicGameState> {
    const { command, initial } = read.ingress;
    const mutationAtEpochMs = Math.max(read.attemptAtEpochMs, (previous?.updatedAtEpochMs ?? -1) + 1);
    if (command.operation !== 'command') {
        if (initial === null) {
            throw new TypeError('Relic initialization lacks its captured proposal');
        }
        const createdAtEpochMs = Math.max(initial.createdAtEpochMs, (previous?.createdAtEpochMs ?? -1) + 1);
        return Either.ofRight({
            ...initial,
            createdAtEpochMs,
            updatedAtEpochMs: Math.max(initial.updatedAtEpochMs, createdAtEpochMs, mutationAtEpochMs)
        });
    }
    if (command.move === null || read.session === null) {
        throw new TypeError('Relic command lacks its move or issued session');
    }
    try {
        return applyRelicCommand(previous ?? initial ?? undefined, {
            ...toRelicCommand(command.move),
            username: read.session.username
        }, {
            senderId: read.session.sessionId,
            now: mutationAtEpochMs
        }).mapRight((result) => result.state);
    }
    catch (error) {
        throw new Error('Relic rule evaluation failed unexpectedly', { cause: error });
    }
}

function refused(
    command: RelicGameMutationService.Command,
    reason: RelicGameMutationService.RefusalReason
): RelicGameMutationService.Computed {
    return { result: refusal(command, reason), guard: null, save: null, outboxWrites: [], provenance: [] };
}

function refusal(
    command: RelicGameMutationService.Command,
    reason: RelicGameMutationService.RefusalReason
): RelicGameMutationService.Refusal {
    return { status: 'refused', gameId: command.gameId, ...reason };
}

export function captureRelicGameCommand(
    value: RelicGameMutationService.CommandInput
): RelicGameMutationService.Command {
    return decodeRelicGameCommand({
        operation: value.operation,
        gameId: value.gameId,
        requestId: value.requestId,
        actor: value.actor,
        authorization: value.authorization,
        move: value.move === null ? null : captureRelicGameMove(value.move)
    });
}

export function decodeRelicGameCommand(value: unknown): RelicGameMutationService.Command {
    const command = requireRecord(value, 'Relic mutation command');
    requireExactKeys(
        command,
        ['operation', 'gameId', 'requestId', 'actor', 'authorization', 'move'],
        'Relic mutation command'
    );
    const operation = requireOneOf(command.operation, ['ensure', 'reset', 'command'], 'Relic operation');
    const authorization = requireOneOf(command.authorization, ['authenticated', 'group-policy'], 'Relic authorization');
    requireString(command.gameId, 'Relic game ID');
    requireString(command.requestId, 'Relic request ID');
    const actor = requireRecord(command.actor, 'Relic actor');
    requireExactKeys(actor, ['clientId', 'sessionId', 'issuedAtEpochMs'], 'Relic actor');
    requireString(actor.clientId, 'Relic actor principal');
    requireString(actor.sessionId, 'Relic actor session');
    requireEpoch(actor.issuedAtEpochMs, 'Relic actor session issuance');
    const move = command.move === null ? null : decodeRelicGameMove(command.move);
    if (operation === 'command' ? move === null || move.gameId !== command.gameId : move !== null) {
        throw new TypeError('Relic move differs from its operation or game');
    }
    return {
        operation,
        authorization,
        gameId: command.gameId,
        requestId: command.requestId,
        actor: { clientId: actor.clientId, sessionId: actor.sessionId, issuedAtEpochMs: Number(actor.issuedAtEpochMs) },
        move
    };
}

export function decodeRelicGameIngress(value: unknown): RelicGameMutationService.Ingress {
    const ingress = requireRecord(value, 'Relic ingress');
    requireExactKeys(ingress, ['command', 'initial', 'capturedAtEpochMs', 'serverPeerId'], 'Relic ingress');
    const command = decodeRelicGameCommand(ingress.command);
    requireEpoch(ingress.capturedAtEpochMs, 'Relic capture time');
    requireString(ingress.serverPeerId, 'Relic logical server peer');
    const initial = ingress.initial === null
        ? null
        : decodeStoredRelicSave(decodeJsonWireValue(ingress.initial), 1, command.gameId);
    return {
        command,
        initial,
        capturedAtEpochMs: Number(ingress.capturedAtEpochMs),
        serverPeerId: ingress.serverPeerId
    };
}

function decodeStoredRelicSave(value: unknown, schemaVersion: number, gameId: string): RelicGameState {
    if (schemaVersion !== 1) {
        throw new TypeError('Unsupported Relic save schema');
    }
    const state = decodeRelicGameStateAppData(decodeJsonWireValue(value));
    if (state.gameId !== gameId || state.roomId !== gameId) {
        throw new TypeError('Relic save identity differs from its room');
    }
    return state;
}
