import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { RelayedAckNoticeChannel } from './relayed-ack-notice.ts';

export interface InstallRelayedAckNoticeSubscriberInput extends RelayedAckNoticeChannel {
    /** Counts the ACK against this instance's aggregate; it runs no handler and sends nothing. */
    readonly acceptRelayedAck: (message: ALMessage, publisherId: string) => Promise<void>;
}

/** An instance never takes its own relayed ACK back, and a relayed ACK is never relayed again. */
export function installRelayedAckNoticeSubscriber(
    input: InstallRelayedAckNoticeSubscriberInput
): Promise<void> {
    return input.transport.subscribe(input.channel, async (notice) => {
        if (notice.publisherId === input.publisherId) {
            return;
        }
        try {
            await input.acceptRelayedAck(notice.message, notice.publisherId);
        }
        catch (error) {
            console.error('Relayed acknowledgement notice receive failed:', error);
        }
    });
}
