import { readRoomTimeline, settleRoomTimeline } from '@shared/api/group-deadlines/room-timeline.ts';
import { requireActiveGroup } from '../policy/group-policy-primitives.ts';
import { groupWrite } from '../mutation/aggregate/compute-group-aggregate-mutation.ts';
import { withGroupTimeRecord } from '../mutation/aggregate/compute-group-clock-change.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../mutation/group-mutation-contracts.ts';
import { auditStamp, noOp, requireGroup } from '../mutation/group-mutation-result.ts';

/** The aggregate predecessor guards both the winning occurrence and the publication of its private member notices. */
export function computeGroupTimelineSettlement(
    command: Extract<GroupMutationCommand, { operation: 'settleTimeline'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const { name, groupCreatedAtEpochMs, revision, dueAtEpochMs } = command.input;
    const group = requireGroup(read, command.aggregateRef).value;
    if (group.kind !== 'room' || group.created.atEpochMs !== groupCreatedAtEpochMs || requireActiveGroup(group, facts.attemptAtEpochMs)) {
        return noOp(command, read, facts);
    }
    const previous = readRoomTimeline(group.metadata, name);
    if (
        previous?.status !== 'running' || previous.revision !== revision || previous.endsAtEpochMs !== dueAtEpochMs ||
        !previous.successor
    ) {
        return noOp(command, read, facts);
    }
    const next = settleRoomTimeline(previous, facts.attemptAtEpochMs);
    if (!next) {
        throw new Error('Timeline deadline is still in the future on this worker');
    }
    // Admission may predate an outage. The new audit, receipt and publications begin at settlement;
    // the phase itself is anchored at the earlier, scheduled boundary.
    const publicationFacts: GroupMutationFacts = {
        ...facts,
        nowEpochMs: facts.attemptAtEpochMs,
        expireAtEpochMs: facts.attemptAtEpochMs + (facts.expireAtEpochMs - facts.nowEpochMs)
    };
    return groupWrite({
        command,
        read,
        facts: publicationFacts,
        eventType: 'group-updated',
        group: {
            ...withGroupTimeRecord(group, next),
            snapshotVersion: group.snapshotVersion + 1,
            metadataVersion: group.metadataVersion + 1,
            updated: auditStamp(command, publicationFacts, undefined)
        }
    });
}
