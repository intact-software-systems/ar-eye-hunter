import {
    resolveBrowserRtcOverlayALOutboundRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import {
    wakeQueueBoxEngineIfQueued,
    writeCarrierOutboxAdmission
} from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { ALDeliveryAdmissionVerdict, ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';

export interface BlackBoxCapturedMessageReplay {
    readonly msgId: string;
    /** The carrier the envelope is re-admitted on; the other carrier's outbound captured it first. */
    readonly carrier: ALDeliveryCarrier;
}

export namespace ReplayBlackBoxCapturedMessage {
    export interface Input extends BlackBoxCapturedMessageReplay {
        readonly sessionId: string | undefined;
        readonly context: ApiMiddleware | undefined;
    }
}

/**
 * A harness capability the product never exercises: the product falls back to the second carrier
 * only after an `unroutable` verdict, so one logical message never reaches both. This admits the
 * envelope the first carrier's outbound retained through the second carrier's own admission call,
 * the one a fallback makes, and answers that carrier's verdict.
 */
export async function replayBlackBoxCapturedMessage(
    input: ReplayBlackBoxCapturedMessage.Input
): Promise<ALDeliveryAdmissionVerdict> {
    const { sessionId, context, msgId, carrier } = input;
    if (sessionId === undefined || context === undefined) {
        throw new Error('A message replay needs a connected session.');
    }
    const captured = await resolveCapturingOutboundStores(sessionId, carrier).admissionStore.readSentMessage(msgId);
    if (captured === undefined) {
        throw new Error(`No captured envelope for ${msgId} is retained to replay on ${carrier}.`);
    }
    const result = await writeCarrierOutboxAdmission(context, carrier, captured.msg);
    wakeQueueBoxEngineIfQueued(context.middleware.qboxEngine, result);
    return result.verdict;
}

function resolveCapturingOutboundStores(
    sessionId: string,
    replayCarrier: ALDeliveryCarrier
): ALOutboundRuntimeStores<ALOutboundTransportMessage> {
    return replayCarrier === 'ws'
        ? resolveBrowserRtcOverlayALOutboundRuntimeStores(sessionId)
        : resolveBrowserWsClientALOutboundRuntimeStores(sessionId);
}
