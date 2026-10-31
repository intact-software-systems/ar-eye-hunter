import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { GroupMove } from '@shared/api/mutation/group-move.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { GroupMoveRejection } from './compute-group-move.ts';

import { type GroupMoveClaim } from '@shared/api/mutation/decode-group-move.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type {
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchWrite
} from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { validateRuntimeStateGuardedBatch } from '../../../runtime-state/guarded-batch/validate-runtime-state-guarded-batch.ts';
import { writeRuntimeStateGuardedBatch } from '../../../runtime-state/postgres/write-runtime-state-guarded-batch.ts';
import { type RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import {
    groupStateChildStorageKey,
    groupStateGroupStorageKey,
    groupStateScopeStorageKey
} from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import {
    decodeGroupMoveRecord,
    decodeStoredGroupMoveClaim,
    type GroupMoveRecord,
    type StoredGroupMoveClaim
} from './group-move-codec.ts';

export const GROUP_MOVES_NAMESPACE = 'group_moves';
const SOURCE_CLAIMS_NAMESPACE = 'group_move_source_claims';
const PARTICIPANT_CLAIMS_NAMESPACE = 'group_move_participant_claims';
const PARTICIPANT_LOOKUP_NAMESPACE = 'group_move_participant_lookup';

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
        const claims = moveClaims(identity, move.participants);
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
        const prefix = `${participantKey(scope, principalId)}:`;
        const [selection] = await this.repository.readRuntimeStateBatch([{
            selectorId: 'principal',
            kind: 'prefix',
            namespace: PARTICIPANT_LOOKUP_NAMESPACE,
            keyPrefix: prefix
        }]);
        const nowEpochMs = this.now();
        const lookups = selection.entries.filter((entry) => entry.expireAtTimestamp > nowEpochMs);
        const moves = await Promise.all(lookups.map(async (stored) => {
            const claim = decodeStoredGroupMoveClaim(JSON.parse(stored.value));
            if (
                stored.key !== lookupKey(claim, principalId) || claim.principalId !== principalId ||
                claim.source.applicationId !== scope.applicationId || claim.source.workspaceId !== scope.workspaceId
            ) {
                throw new TypeError('Stored group move participant lookup identity differs');
            }
            const record = await this.find(claim);
            if (!record) {
                return null; // The shared retention deadline may pass between these reads.
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
    const claims = computeClaimEffects(input.read, move, expireAtTimestamp);
    return claims.mapRight((effects) =>
        computeRuntimeStateGuardedBatchWrite(validateRuntimeStateGuardedBatch({
            guard: {
                namespace: GROUP_MOVES_NAMESPACE,
                key: moveKey(input.read.identity),
                value: JSON.stringify(record),
                expireAtTimestamp,
                ...(previous
                    ? { operation: 'update', expectedRevision: previous.entry.revision }
                    : { operation: 'insert' })
            },
            effects
        }))
    );
}

function selectedClaims(
    read: GroupMoveRepository.Read,
    participants: GroupMove['participants']
): readonly GroupMoveRepository.ClaimRead[] {
    return moveClaims(read.identity, participants).map((expected) => {
        const matching = read.claims.filter((claim) =>
            claim.kind === expected.kind && claim.namespace === expected.namespace && claim.key === expected.key &&
            claim.principalId === expected.principalId
        );
        if (matching.length !== 1) {
            throw new TypeError('Group move read does not contain every selected claim exactly once');
        }
        return matching[0];
    });
}

function computeClaimEffects(
    read: GroupMoveRepository.Read,
    move: GroupMove,
    expireAtTimestamp: number
): Either<GroupMoveRejection, readonly RuntimeStateGuardedBatchEffect[]> {
    const previous = read.record;
    const effects: RuntimeStateGuardedBatchEffect[] = [];
    const claims = selectedClaims(read, move.participants);
    for (const claim of claims) {
        const current = claim.current;
        const claimIdentity = { ...read.identity, principalId: claim.principalId };
        const owned = current !== null && jsonEquals(current.value, claimIdentity);
        if (previous?.value.move.status === 'proposed' && !owned) {
            throw new TypeError('Pending group move has lost a required claim');
        }
        if (!previous && owned) {
            throw new TypeError('Group move claim has no preceding proposal');
        }
        if (claim.kind !== 'lookup' && current && !owned) {
            if (previous?.value.move.status !== 'proposed' && move.status !== 'proposed') {
                continue;
            }
            return Either.ofLeft({
                code: 'group-move-rejected',
                message: 'A source room or participant already has a pending move.'
            });
        }
        if (claim.kind !== 'lookup' && move.status !== 'proposed') {
            if (current && owned) {
                effects.push({
                    effectId: claim.key,
                    operation: 'delete',
                    namespace: claim.namespace,
                    key: claim.key,
                    expectedRevision: current.entry.revision
                });
            }
            continue;
        }
        effects.push({
            effectId: `${claim.kind}:${claim.key}`,
            namespace: claim.namespace,
            key: claim.key,
            value: JSON.stringify(claimIdentity),
            expireAtTimestamp: claim.kind === 'lookup' ? expireAtTimestamp : NEVER_EXPIRE_AT_TIMESTAMP,
            ...(current ? { operation: 'update', expectedRevision: current.entry.revision } : { operation: 'insert' })
        });
    }
    return Either.ofRight(effects);
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

function moveClaims(
    identity: GroupMoveClaim,
    participants: readonly Pick<GroupMove['participants'][number], 'principalId'>[]
): Omit<GroupMoveRepository.ClaimRead, 'current'>[] {
    const principals = [...new Set(participants.map((participant) => participant.principalId))].sort();
    return [
        {
            kind: 'source',
            principalId: null,
            namespace: SOURCE_CLAIMS_NAMESPACE,
            key: groupStateGroupStorageKey(identity.source)
        },
        ...principals.map((principalId) => ({
            kind: 'participant' as const,
            principalId,
            namespace: PARTICIPANT_CLAIMS_NAMESPACE,
            key: participantKey(identity.source, principalId)
        })),
        ...principals.map((principalId) => ({
            kind: 'lookup' as const,
            principalId,
            namespace: PARTICIPANT_LOOKUP_NAMESPACE,
            key: lookupKey(identity, principalId)
        }))
    ];
}

function moveKey(identity: GroupMoveClaim): string {
    return groupStateChildStorageKey(identity.source, 'move', identity.moveId);
}

function participantKey(scope: Pick<GroupRef, 'applicationId' | 'workspaceId'>, principalId: string): string {
    return `${groupStateScopeStorageKey(scope)}:principal=${encodeURIComponent(principalId)}`;
}

function lookupKey(identity: GroupMoveClaim, principalId: string): string {
    return `${participantKey(identity.source, principalId)}:source=${
        encodeURIComponent(identity.source.groupId)
    }:move=${encodeURIComponent(identity.moveId)}`;
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
