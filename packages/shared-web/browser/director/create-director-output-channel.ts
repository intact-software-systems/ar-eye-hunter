import type {
    RallarDirectorRelayConfig,
    RallarDirectorRelayEnvelope,
    RallarDirectorStatus
} from '@shared-web/browser/director/rallar-director-facade.ts';
import type {
    RallarMessageOrderGap,
    RallarTypedMessageChannel
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';

/**
 * A receipted output is retried after its 2 s ACK timeout, so 3 s covers the first retry and its delivery. A later
 * output is not held longer than that for a missing one.
 */
const DIRECTOR_OUTPUT_GAP_WAIT_MS = 3_000;

export namespace CreateDirectorOutputChannel {
    export interface Input {
        readonly messages: Pick<RallarMessagesOperations, 'room'>;
        readonly topicId: string;
        readonly typeId: string;
        readonly onOutputGap: RallarDirectorRelayConfig<unknown, unknown>['onOutputGap'];
        isStopped(): boolean;
        readStatus(): RallarDirectorStatus;
    }
}

/**
 * The relay's edge-ordered output channel. It names no room: every output send names its room, and the declaration
 * is per topic and type on this page for every room.
 */
export function createDirectorOutputChannel<TOutput>(
    input: CreateDirectorOutputChannel.Input
): RallarTypedMessageChannel<RallarDirectorRelayEnvelope<TOutput>> {
    return input.messages.room<RallarDirectorRelayEnvelope<TOutput>>({
        topicId: input.topicId,
        typeId: input.typeId,
        purpose: 'notification',
        access: 'members',
        order: 'edge',
        orderGapWaitMs: DIRECTOR_OUTPUT_GAP_WAIT_MS,
        onOrderGap: async (gap) => await passOutputGap(input, gap)
    });
}

/** The declaration stands for every room on this page and a gap names none, so the sender is the fence. */
async function passOutputGap(input: CreateDirectorOutputChannel.Input, gap: RallarMessageOrderGap): Promise<void> {
    if (input.isStopped() || gap.senderId !== input.readStatus().appointment?.sessionId) {
        return;
    }
    await input.onOutputGap?.(gap);
}
