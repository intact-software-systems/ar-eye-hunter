import type { EdgeOrderSendStreams } from '@shared-web/browser/messages/edge-order/edge-order-send-streams.ts';
import { toEdgeOrderWireJson } from '@shared-web/browser/messages/edge-order/edge-order-wire-payload.ts';
import type {
    BrowserPublicationPacing,
    BrowserPublicationRequest
} from '@shared-web/browser/messages/publication/browser-publication-stages.ts';
import type { BrowserTypedChannelPolicy } from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

export interface EdgeOrderLiveStampInput {
    readonly channel: BrowserTypedChannelPolicy | undefined;
    readonly publication: BrowserPublicationPacing;
    readonly streams: Pick<EdgeOrderSendStreams, 'openLiveSend'>;
    /** The connect's server clock, as a stamp reads it. */
    readNowMs(): number;
    validateSerializedPayload(serialized: string): readonly RallarValidationIssue[];
}

/**
 * How an edge-ordered live channel's value is stamped when it leaves the stage; absent for a live channel that
 * declares no order. The value takes the next position of its publication stream then, its envelope's payload is
 * wrapped with it, and the payload limit counts the wrapper.
 */
export function toEdgeOrderLiveStamp(input: EdgeOrderLiveStampInput): BrowserPublicationRequest['stampAtOpportunity'] {
    if (input.channel?.order !== 'edge') {
        return undefined;
    }
    return (message) => {
        const resource = toEdgeOrderWireJson(
            input.streams.openLiveSend(input.publication.streamKey).stamp(input.readNowMs()),
            message.payload.resource
        );
        return {
            message: { ...message, payload: { ...message.payload, resource } },
            payloadIssues: input.validateSerializedPayload(resource)
        };
    };
}
