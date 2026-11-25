import type { ALOutboundCommitBundle } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';

/**
 * Another commit of the same message as `losing`, on that message's own version and writing none of its rows but its
 * repair count: committed first, it moves the version `losing` fences on, whatever else `losing` fences.
 *
 * For a message that is admitted, its production twin is the receipt admission's commit on the message's own version.
 * For a message that is not admitted yet, no production commit leaves this state: it writes a version row for a
 * message that does not exist, a stand-in for "some commit won the message fence". A production competitor there (a
 * duplicate enqueue) would also write the message, and so change the verdict the retried decision reads.
 */
export function toCompetingOutboundMessageCommit<TPrepared>(
    losing: Pick<ALOutboundCommitBundle<TPrepared>, 'senderId' | 'expectedVersion' | 'message'>
): ALOutboundCommitBundle<TPrepared> {
    return {
        senderId: losing.senderId,
        expectedVersion: losing.expectedVersion,
        fencesSender: false,
        message: losing.message,
        mutations: [{ kind: 'delete-repair-attempt', msgId: losing.message.msgId }],
        durableEffects: [],
        endedTimeoutEffectIds: []
    };
}
