import { requireEpoch, requireExactKeys, requireRecord } from '@shared/api/exact-object-decoding.ts';
import { decodeGroupMoveClaim, moveIdentifier, type GroupMoveClaim } from '@shared/api/mutation/decode-group-move.ts';
import { GROUP_MOVE_MAX_SESSIONS, type GroupMove } from '@shared/api/mutation/group-move.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';

export const GROUP_MOVE_DEADLINE_TOPIC = 'group-move.deadline';

export interface GroupMoveProposalDeadline extends GroupMoveClaim {
    readonly expiresAtEpochMs: number;
}

export interface GroupMoveHistoryDeadline extends GroupMoveClaim {
    readonly kind: 'terminal-retention';
    readonly moveCreatedAtEpochMs: number;
    readonly completedAtEpochMs: number;
    readonly dueAtEpochMs: number;
    readonly principalIds: readonly string[];
}

export type GroupMoveDeadline = GroupMoveProposalDeadline | GroupMoveHistoryDeadline;

export function decodeGroupMoveDeadline(value: unknown): GroupMoveDeadline {
    const record = requireRecord(value, 'Group move deadline');
    const claim = decodeGroupMoveClaim({ source: record.source, moveId: record.moveId });
    if (!Object.hasOwn(record, 'kind')) {
        requireExactKeys(record, ['source', 'moveId', 'expiresAtEpochMs'], 'Group move proposal deadline');
        requireEpoch(record.expiresAtEpochMs, 'Move proposal expiry');
        if (record.expiresAtEpochMs === 0) {
            throw new TypeError('Move proposal expiry must be positive');
        }
        return { ...claim, expiresAtEpochMs: record.expiresAtEpochMs };
    }
    requireExactKeys(record, [
        'kind',
        'source',
        'moveId',
        'moveCreatedAtEpochMs',
        'dueAtEpochMs',
        'completedAtEpochMs',
        'principalIds'
    ], 'Group move history deadline');
    const { moveCreatedAtEpochMs, dueAtEpochMs } = record;
    requireEpoch(moveCreatedAtEpochMs, 'Move creation');
    requireEpoch(dueAtEpochMs, 'Move deadline');
    const { completedAtEpochMs } = record;
    requireEpoch(completedAtEpochMs, 'Terminal move completion');
    if (
        record.kind !== 'terminal-retention' || completedAtEpochMs < moveCreatedAtEpochMs ||
        dueAtEpochMs <= completedAtEpochMs ||
        !Array.isArray(record.principalIds) || record.principalIds.length < 1 ||
        record.principalIds.length > GROUP_MOVE_MAX_SESSIONS
    ) {
        throw new TypeError('Move history deadline has invalid lifetime or cohort');
    }
    const principalIds = record.principalIds.map(moveIdentifier);
    if (principalIds.some((principalId, index) => index > 0 && principalIds[index - 1] >= principalId)) {
        throw new TypeError('Move history deadline requires sorted unique principals');
    }
    return {
        ...claim,
        kind: 'terminal-retention',
        moveCreatedAtEpochMs,
        completedAtEpochMs,
        dueAtEpochMs,
        principalIds
    };
}

export function toGroupMoveDeadline(
    move: GroupMove,
    previousStatus: GroupMove['status'] | null,
    retentionMs: number
): GroupMoveDeadline | null {
    const identity = { source: move.source, moveId: move.moveId, moveCreatedAtEpochMs: move.createdAtEpochMs };
    if (previousStatus === null) {
        return decodeGroupMoveDeadline({
            source: move.source,
            moveId: move.moveId,
            expiresAtEpochMs: move.expiresAtEpochMs
        });
    }
    if (previousStatus === 'proposed' && move.completedAtEpochMs !== null) {
        return decodeGroupMoveDeadline({
            ...identity,
            kind: 'terminal-retention',
            completedAtEpochMs: move.completedAtEpochMs,
            dueAtEpochMs: move.completedAtEpochMs + retentionMs,
            principalIds: [...new Set(move.participants.map((participant) => participant.principalId))].sort()
        });
    }
    return null;
}

export function toGroupMoveDeadlineRoute(command: GroupMoveDeadline): Key {
    return toAppQueueKey({
        topicId: GROUP_MOVE_DEADLINE_TOPIC,
        resourceId: `gm-${computeSha256CanonicalJson(command).slice(7, 37)}`,
        contextId: groupStateGroupStorageKey(command.source)
    });
}

export function groupMoveDeadlineDueAt(command: GroupMoveDeadline): number {
    return 'expiresAtEpochMs' in command ? command.expiresAtEpochMs : command.dueAtEpochMs;
}
