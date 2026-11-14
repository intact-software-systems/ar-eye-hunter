import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import {
    createOriginOverlay,
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM
} from './rtc-origin-overlay-fixture.ts';
import { createRtcRelayOverlayFixture, type RtcRelayOverlayFixture } from './rtc-relay-overlay-fixture.ts';

/** What a relay's own outbound diagnostics say about the copy it was asked to forward. */

type Reliability = 'at-least-once' | 'best-effort';

const CHAIN: Readonly<Record<string, readonly string[]>> = { a: ['c'], c: ['a', 'd'], d: ['c'] };
/** The relay `c` as a leaf: its accepted layout names the sender `a` alone, so a copy it forwards has no next hop. */
const LEAF: Readonly<Record<string, readonly string[]>> = { a: ['c'], c: ['a'] };

function createFrame(reliability: Reliability, resourceId: string): ALMessage {
    return reliability === 'at-least-once'
        ? createOriginReceiverMulticast(resourceId)
        : newALMulticastMessage(
            'a',
            { topicId: 'position', resourceId, contextId: 'room' },
            ORIGIN_ROOM,
            'position.frame.v1',
            { resourceId },
            { reliability: 'best-effort', ack: 'none', ttlMs: 30_000 }
        );
}

/** The deployment refuses a repair on the way out only: the relay admits the copy, and its forwarding plan has an unmet requirement. */
const NO_OUTBOUND_REPAIR: ALQosInputProvider = {
    authorizationForMessage: (_msg, context) => context.direction === 'outbound' ? { allowedRepairs: [] } : undefined
};

function createRelay(tree: Readonly<Record<string, readonly string[]>>, qosProvider?: ALQosInputProvider): RtcRelayOverlayFixture {
    return createRtcRelayOverlayFixture({
        qosProvider,
        selfPeerId: 'c',
        snapshot: createOriginSnapshot(['a', 'c', 'd'], 4),
        neighbourPeerIds: tree.c!,
        initialOverlay: createOriginOverlay(tree.c!, tree)
    });
}

function readForwardEvents(relay: RtcRelayOverlayFixture): readonly ALOutboundRuntimeDiagnosticsEvent[] {
    return relay.outboundDiagnostics.filter((event) => event.kind === 'relay-forward-not-enqueued');
}

describe('a relay\'s forward and its outbound diagnostics', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('a relay whose forward the planner drops reports the drop with the message, its type and the reason', async () => {
        const relay = createRelay(CHAIN, NO_OUTBOUND_REPAIR);
        const frame = createFrame('at-least-once', 'planner-drop');

        await relay.forward(frame, 'a');

        expect(readForwardEvents(relay)).toEqual([
            expect.objectContaining({
                kind: 'relay-forward-not-enqueued',
                msgId: frame.id.msgId,
                typeId: frame.payload.typeId,
                outcome: 'skipped',
                reason: 'planner-drop'
            })
        ]);
    });

    it('a relay whose forward has no route reports the refusal with the message, its type and the reason', async () => {
        const relay = createRelay(LEAF);
        const frame = createFrame('at-least-once', 'no-route');

        await relay.forward(frame, 'a');

        expect(readForwardEvents(relay)).toEqual([
            expect.objectContaining({
                kind: 'relay-forward-not-enqueued',
                msgId: frame.id.msgId,
                typeId: frame.payload.typeId,
                outcome: 'unroutable',
                reason: 'no-route'
            })
        ]);
    });

    it.each(['at-least-once', 'best-effort'] as const)(
        'a relay whose %s forward is enqueued, or already present, reports nothing',
        async (reliability) => {
            const relay = createRelay(CHAIN);
            const frame = createFrame(reliability, 'enqueued');

            await relay.forward(frame, 'a');
            await relay.forward(frame, 'a');

            expect((await relay.readSent('d')).filter((sent) => sent.id.msgId === frame.id.msgId)).toHaveLength(1);
            expect(readForwardEvents(relay)).toEqual([]);
        }
    );

    it('a relay that receives a frame through its receive pipeline forwards it and reports nothing', async () => {
        const snapshot = createOriginSnapshot(['a', 'c', 'd'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['c'], nextHopsBySessionId: CHAIN });
        const relay = createRelay(CHAIN);
        const frame = createFrame('at-least-once', 'received');
        await enqueueAndDrain(origin.manager, frame);

        await relay.receive(origin.channels.c!.sent.find((sent) => sent.id.msgId === frame.id.msgId)!, 'a');

        expect((await relay.readSent('d')).filter((sent) => sent.id.msgId === frame.id.msgId)).toHaveLength(1);
        expect(readForwardEvents(relay)).toEqual([]);
    });

    it('an origin\'s own send whose planner drops it reports no relay forward', async () => {
        const snapshot = createOriginSnapshot(['a', 'c', 'd'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: [], nextHopsBySessionId: { a: [] } });
        const frame = createFrame('best-effort', 'origin-drop');

        await enqueueAndDrain(origin.manager, frame);

        expect(origin.diagnostics.filter((event) => event.kind === 'relay-forward-not-enqueued')).toEqual([]);
    });
});
