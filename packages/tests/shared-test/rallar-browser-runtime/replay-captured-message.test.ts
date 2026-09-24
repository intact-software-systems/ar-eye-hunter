// @vitest-environment happy-dom
import '../../setup-browser-indexeddb.ts';

import { replayBlackBoxCapturedMessage } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/replay-black-box-captured-message.ts';
import { deleteBrowserALRuntimeEntriesForSession } from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
import {
    configureBrowserALRuntimeStores,
    resolveBrowserRtcOverlayALOutboundRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundMessageRuntime, ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    toALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { createDefaultApiMiddlewareTestDouble } from '../../shared-web/api-middleware-test-double.ts';
import { createOutboundMessage, createOutboundTestRuntimeFor } from '../../shared/alm/outbound-runtime-test-fixture.ts';

interface SessionOutbounds {
    readonly sessionId: string;
    readonly context: ApiMiddleware;
    readonly wake: ReturnType<typeof vi.fn>;
    readonly admit: (carrier: ALDeliveryCarrier, message: ALMessage) => ReturnType<ALOutboundMessageRuntime<ALOutboundTransportMessage>['enqueueIfAbsent']>;
}

const diagnosticsPorts = toRallarDiagnosticsPorts(undefined);

/** Both carrier outbounds of one browser session over its real stores; nothing is ever ready to submit. */
function createSessionOutbounds(): SessionOutbounds {
    const sessionId = `replay-${crypto.randomUUID()}`;
    configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts });
    const rtc = createUnsubmittingOutbound(resolveBrowserRtcOverlayALOutboundRuntimeStores(sessionId), 'rtc');
    const ws = createUnsubmittingOutbound(resolveBrowserWsClientALOutboundRuntimeStores(sessionId), 'ws');
    onTestFinished(async () => {
        rtc.dispose();
        ws.dispose();
        await deleteBrowserALRuntimeEntriesForSession(sessionId, { onStorageReset: diagnosticsPorts.onStorageReset });
    });
    const wake = vi.fn();
    const context = createDefaultApiMiddlewareTestDouble({
        session: { sessionId },
        middleware: {
            qboxEngine: { wake },
            rtcRxStreamer: { enqueueOutboxIfAbsent: async (message) => await rtc.enqueueIfAbsent(message) },
            webSocketQueueBox: { enqueueOutboxIfAbsent: async (message) => await ws.enqueueIfAbsent(message) }
        }
    });
    return {
        sessionId,
        context,
        wake,
        admit: async (carrier, message) => await (carrier === 'rtc' ? rtc : ws).enqueueIfAbsent(message)
    };
}

function createUnsubmittingOutbound(
    stores: ALOutboundRuntimeStores<ALOutboundTransportMessage>,
    carrier: ALDeliveryCarrier
): ALOutboundMessageRuntime<ALOutboundTransportMessage> {
    return createOutboundTestRuntimeFor({
        queueEngine: new InboxOutboxEngine(),
        stores,
        carrier,
        decodePreparedMessage: decodeALOutboundTransportMessage,
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: true,
            preparedMessages: [toALOutboundTransportMessage(msg)]
        }),
        sendPreparedMessage: async () => ({ status: 'not-ready', submissionAttempted: false, retryAfterMs: 60_000 })
    });
}

describe('replaying a captured envelope on the other carrier', () => {
    it.each(
        [
            ['rtc', 'ws'],
            ['ws', 'rtc']
        ] as const
    )('admits the %s capture on %s: each outbound keeps its own sent row despite the shared scope', async (first, replay) => {
        const session = createSessionOutbounds();
        const message = createOutboundMessage(`replayed-${first}`);
        expect((await session.admit(first, message)).verdict).toMatchObject({ kind: 'admitted' });

        const verdict = await replayBlackBoxCapturedMessage({
            sessionId: session.sessionId,
            context: session.context,
            msgId: message.id.msgId,
            carrier: replay
        });
        const again = await replayBlackBoxCapturedMessage({
            sessionId: session.sessionId,
            context: session.context,
            msgId: message.id.msgId,
            carrier: replay
        });

        expect(verdict).toMatchObject({ kind: 'admitted', durable: true });
        expect(again).toEqual({ kind: 'duplicate' });
        expect(session.wake).toHaveBeenCalledTimes(2);
    });

    it('refuses a msgId the other carrier never captured instead of admitting nothing', async () => {
        const session = createSessionOutbounds();
        const message = createOutboundMessage('captured-on-ws-only');
        await session.admit('ws', message);

        await expect(replayBlackBoxCapturedMessage({
            sessionId: session.sessionId,
            context: session.context,
            msgId: message.id.msgId,
            carrier: 'ws'
        })).rejects.toThrow(`No captured envelope for ${message.id.msgId} is retained to replay on ws.`);
    });

    it('refuses a replay without a connected session', async () => {
        await expect(replayBlackBoxCapturedMessage({
            sessionId: undefined,
            context: undefined,
            msgId: 'any',
            carrier: 'rtc'
        })).rejects.toThrow('A message replay needs a connected session.');
    });
});
