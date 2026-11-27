import type { EdgeOrderSendStreams } from '@shared-web/browser/messages/edge-order/edge-order-send-streams.ts';
import { toEdgeOrderWireJson } from '@shared-web/browser/messages/edge-order/edge-order-wire-payload.ts';
import type {
    BrowserPublicationPacing,
    BrowserPublicationRequest
} from '@shared-web/browser/messages/publication/browser-publication-stages.ts';
import type { BrowserTypedChannelPolicy } from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

export interface ToBrowserPublicationRequestInput {
    readonly channel: BrowserTypedChannelPolicy | undefined;
    /** Absent for a send of a channel that is not live. */
    readonly publication: BrowserPublicationPacing | undefined;
    readonly edgeOrderStreams: Pick<EdgeOrderSendStreams, 'openLiveSend'>;
    /** The connect's server clock, as a stamp reads it. */
    readNowMs(): number;
    validateSerializedPayload(serialized: string): readonly RallarValidationIssue[];
}

/**
 * What a live channel's delivery asks of the stage and of the dispatch; absent for any other channel's. On an
 * edge-ordered live channel the value is stamped when it leaves the stage: it takes the next position of its
 * publication stream then, its envelope's payload is wrapped with it, and the payload limit counts the wrapper.
 */
export function toBrowserPublicationRequest(
    input: ToBrowserPublicationRequestInput
): BrowserPublicationRequest | undefined {
    const { publication } = input;
    if (publication === undefined) {
        return undefined;
    }
    if (input.channel?.order !== 'edge') {
        return { ...publication, stampAtOpportunity: undefined };
    }
    return {
        ...publication,
        stampAtOpportunity: (message) => {
            const resource = toEdgeOrderWireJson(
                input.edgeOrderStreams.openLiveSend(publication.streamKey).stamp(input.readNowMs()),
                message.payload.resource
            );
            return {
                message: { ...message, payload: { ...message.payload, resource } },
                payloadIssues: input.validateSerializedPayload(resource)
            };
        }
    };
}
