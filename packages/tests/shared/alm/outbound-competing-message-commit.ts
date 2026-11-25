import type { ALOutboundCommitBundle } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';

/**
 * Another commit of the same message as `losing`, on that message's own version and writing none of its rows but its
 * repair count: committed first, it moves the version `losing` fences on, whatever else `losing` fences.
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
