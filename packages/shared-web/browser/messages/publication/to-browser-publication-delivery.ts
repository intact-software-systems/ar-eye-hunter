import type { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import type { BrowserTypedChannelPolicy } from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    toALPublicationLaneKey,
    toALPublicationStreamKey
} from '@shared/al-contracts/publication/to-al-publication-stream-key.ts';

/**
 * A live channel's envelope, conflated latest-wins on its stream so a late copy is superseded at admission and on
 * receipt as well, and the publication the stage paces it by (D467). Any other channel's envelope is unchanged.
 */
export function toBrowserPublicationDelivery(
    message: ALMessage,
    channel: BrowserTypedChannelPolicy | undefined
): Pick<BrowserRallarMessageDispatch.Delivery, 'message' | 'publication'> {
    const policy = channel?.publication;
    if (policy === undefined) {
        return { message, publication: undefined };
    }
    const streamKey = toALPublicationStreamKey(message);
    return {
        message: {
            ...message,
            qos: { ...message.qos, supersedence: { algo: 'latest-wins', opts: { supersedenceKey: streamKey } } }
        },
        publication: { policy, laneKey: toALPublicationLaneKey(message), streamKey }
    };
}
