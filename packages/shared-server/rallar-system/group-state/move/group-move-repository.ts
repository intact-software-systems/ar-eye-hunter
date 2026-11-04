import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { type GroupMoveClaim } from '@shared/api/mutation/decode-group-move.ts';
import type { GroupMove } from '@shared/api/mutation/group-move.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type { RuntimeStateGuardedBatchWrite } from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { validateRuntimeStateGuardedBatch } from '../../../runtime-state/guarded-batch/validate-runtime-state-guarded-batch.ts';
import { writeRuntimeStateGuardedBatch } from '../../../runtime-state/postgres/write-runtime-state-guarded-batch.ts';
import { type RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { groupStateChildStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import type { GroupMoveRejection } from './compute-group-move.ts';
import {
    computeGroupMoveClaimEffects,
    GROUP_MOVE_PARTICIPANT_LOOKUP_NAMESPACE,
    groupMoveClaimSlots,
    groupMoveLookupKey,
    groupMovePrincipalKey
} from './group-move-claims.ts';
import {
    decodeGroupMoveRecord,
    decodeStoredGroupMoveClaim,
    type GroupMoveRecord,
    type StoredGroupMoveClaim
} from './group-move-codec.ts';

export const GROUP_MOVES_NAMESPACE = 'group_moves';
export namespace GroupMoveRepository {
    export interface ClaimRead {
        readonly kind: 'source' | 'participant' | 'lookup';
        readonly namespace: string;
        readonly key: string;
        readonly principalId: string | null;
        readonly current: RuntimeStateEntryValue<StoredGroupMoveClaim> | null;
    }

    export interface Read {
        readonly identity: GroupMoveClaim;
        readonly record: RuntimeStateEntryValue<GroupMoveRecord> | null;
        readonly claims: readonly ClaimRead[];
    }

    export interface ComputeInput {
        readonly read: Read;
        readonly record: GroupMoveRecord;
        readonly terminalRetentionMs: number;
    }
}

/** Durable claims and participant discovery share the proposal's transaction and retention. */
export class GroupMoveRepository {
    private readonly repository: RuntimeStateRepositoryLike;
    private readonly now: () => number;

    constructor(repository: RuntimeStateRepositoryLike, now: () => number) {
        this.repository = repository;
        this.now = now;
    }

    async find(identity: GroupMoveClaim): Promise<RuntimeStateEntryValue<GroupMoveRecord> | null> {
        const stored = await this.repository.findEntry(GROUP_MOVES_NAMESPACE, moveKey(identity));
        return stored && stored.expireAtTimestamp > this.now() ? decodeStoredMove(stored, identity) : null;
    }

    async read(
        move:
            & Pick<GroupMove, 'source' | 'moveId'>
            & Readonly<{ participants: readonly Pick<GroupMove['participants'][number], 'principalId'>[]; }>
    ): Promise<GroupMoveRepository.Read> {
        const identity = { source: move.source, moveId: move.moveId };
        const claims = groupMoveClaimSlots(identity, move.participants);
        const selectors = [
            { selectorId: 'move', kind: 'key' as const, namespace: GROUP_MOVES_NAMESPACE, key: moveKey(identity) },
            ...claims.map((claim, index) => ({
                selectorId: `claim-${index}`,
                kind: 'key' as const,
                namespace: claim.namespace,
                key: claim.key
            }))
        ];
        const selections = await this.repository.readRuntimeStateBatch(selectors);
        const nowEpochMs = this.now();
        const stored = selections[0].entries[0];
        return {
            identity,
            record: stored && stored.expireAtTimestamp > nowEpochMs ? decodeStoredMove(stored, identity) : null,
            claims: claims.map((claim, index) => {
                const entry = selections[index + 1].entries[0];
                if (!entry || entry.expireAtTimestamp <= nowEpochMs) {
                    return { ...claim, current: null };
                }
                const value = decodeStoredGroupMoveClaim(JSON.parse(entry.value));
                if (
                    entry.key !== claim.key || value.principalId !== claim.principalId ||
                    value.source.applicationId !== move.source.applicationId ||
                    value.source.workspaceId !== move.source.workspaceId ||
                    (claim.kind === 'source' && !isSameGroupRef(value.source, move.source)) ||
                    (claim.kind === 'lookup' && !jsonEquals(value, { ...identity, principalId: claim.principalId }))
                ) {
                    throw new TypeError('Stored group move claim identity differs from its key');
                }
                return { ...claim, current: { entry, value } };
            })
        };
    }

    async listForPrincipal(
        scope: Pick<GroupRef, 'applicationId' | 'workspaceId'>,
        principalId: string
    ): Promise<readonly GroupMove[]> {
        const prefix = `${groupMovePrincipalKey(scope, principalId)}:`;
        const [selection] = await this.repository.readRuntimeStateBatch([{
            selectorId: 'principal',
            kind: 'prefix',
            namespace: GROUP_MOVE_PARTICIPANT_LOOKUP_NAMESPACE,
            keyPrefix: prefix
        }]);
        const nowEpochMs = this.now();
        const lookups = selection.entries.filter((entry) => entry.expireAtTimestamp > nowEpochMs);
        const moves = await Promise.all(lookups.map(async (stored) => {
            const claim = decodeStoredGroupMoveClaim(JSON.parse(stored.value));
            if (
                stored.key !== groupMoveLookupKey(claim, principalId) || claim.principalId !== principalId ||
                claim.source.applicationId !== scope.applicationId || claim.source.workspaceId !== scope.workspaceId
            ) {
                throw new TypeError('Stored group move participant lookup identity differs');
            }
            const record = await this.find(claim);
            if (!record || stored.expireAtTimestamp <= this.now()) {
                return null; // The lookup can expire and its move ID can be reused between these reads.
            }
            if (!record.value.move.participants.some((participant) => participant.principalId === principalId)) {
                throw new TypeError('Stored group move lookup points to a nonparticipant');
            }
            return record.value.move;
        }));
        return moves.filter((move): move is GroupMove => move !== null)
            .sort((left, right) =>
                right.createdAtEpochMs - left.createdAtEpochMs || left.moveId.localeCompare(right.moveId)
            );
    }
}

export function computeGroupMoveStorage(
    input: GroupMoveRepository.ComputeInput
): Either<GroupMoveRejection, RuntimeStateGuardedBatchWrite> {
    const record = decodeGroupMoveRecord(input.record);
    const { move } = record;
    if (!jsonEquals(input.read.identity, { source: move.source, moveId: move.moveId })) {
        throw new TypeError('Group move persistence identity differs from its read');
    }
    if (!Number.isSafeInteger(input.terminalRetentionMs) || input.terminalRetentionMs <= 0) {
        throw new TypeError('Group move retention must be a positive safe integer');
    }
    const previous = input.read.record;
    if (previous && !jsonEquals(moveIdentity(previous.value.move), moveIdentity(move))) {
        throw new TypeError('Group move immutable identity or cohort changed');
    }
    if (
        previous && previous.value.move.status !== 'proposed' &&
        !jsonEquals(terminalDecision(previous.value.move), terminalDecision(move))
    ) {
        throw new TypeError('Group move terminal decision cannot change');
    }
    const expireAtTimestamp = move.completedAtEpochMs === null
        ? NEVER_EXPIRE_AT_TIMESTAMP
        : move.completedAtEpochMs + input.terminalRetentionMs;
    if (!previous && move.status !== 'proposed') {
        throw new TypeError('A terminal group move requires a preceding proposal');
    }
    const claims = computeGroupMoveClaimEffects(input.read, move, expireAtTimestamp);
    return claims.mapRight((effects) =>
        computeRuntimeStateGuardedBatchWrite(validateRuntimeStateGuardedBatch({
            guard: {
                namespace: GROUP_MOVES_NAMESPACE,
                key: moveKey(input.read.identity),
                value: JSON.stringify(record),
                expireAtTimestamp,
                ...(previous
                    ? {
                        operation: 'update-exact',
                        expectedRevision: previous.entry.revision,
                        expectedValue: previous.entry.value
                    }
                    : { operation: 'insert' })
            },
            effects
        }))
    );
}

export async function writeGroupMoveStorage(
    transaction: PSqlSql,
    write: RuntimeStateGuardedBatchWrite
): Promise<'applied' | 'conflict'> {
    const result = await writeRuntimeStateGuardedBatch(transaction, write);
    if (result.guard.status !== 'applied' || result.effects.some((effect) => effect.status !== 'applied')) {
        return 'conflict';
    }
    return 'applied';
}

function decodeStoredMove(entry: RuntimeStateEntry, identity: GroupMoveClaim): RuntimeStateEntryValue<GroupMoveRecord> {
    const value = decodeGroupMoveRecord(JSON.parse(entry.value));
    if (
        entry.key !== moveKey(identity) || !isSameGroupRef(value.move.source, identity.source) ||
        value.move.moveId !== identity.moveId
    ) {
        throw new TypeError('Stored group move identity differs from its key');
    }
    return { entry, value };
}

function moveKey(identity: GroupMoveClaim): string {
    return groupStateChildStorageKey(identity.source, 'move', identity.moveId);
}

function moveIdentity(move: GroupMove): object {
    return {
        ...move,
        participants: move.participants.map((
            { confirmedAtEpochMs: _confirmed, arrivedAtEpochMs: _arrived, ...identity }
        ) => identity),
        completedAtEpochMs: null,
        status: null,
        reason: null,
        admissionFailure: null
    };
}

function terminalDecision(move: GroupMove): object {
    return {
        ...move,
        participants: move.participants.map(({ arrivedAtEpochMs: _arrived, ...participant }) => participant)
    };
}
