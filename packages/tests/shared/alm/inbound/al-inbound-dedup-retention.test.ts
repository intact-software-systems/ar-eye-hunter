import '../../../setup-browser-indexeddb.ts';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage, type ALAckStatus } from '@shared/al-contracts/al-control.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SELF_PEER_ID,
    INBOUND_TEST_SENDER_PEER_ID,
    type InboundTestRuntime,
    type InboundTestStorage
} from '../inbound-runtime-test-fixture.ts';

const SOURCE: ALInboundMessageRuntime.Source = {
    kind: 'rtc-peer',
    peerId: INBOUND_TEST_SENDER_PEER_ID
};
/** Twice the default 60 s dedup window, so a replay can land past the window and inside the deadline. */
const DEADLINE_MS = 120_000;
const INSIDE_THE_WINDOW_MS = 30_000;
const PAST_THE_WINDOW_MS = 61_000;

interface ObservedAck {
    readonly toPeerId: string;
    readonly ackedMsgId: string;
    readonly status: ALAckStatus;
}

function createRuntime(storage: InboundTestStorage): InboundTestRuntime {
    return createInboundTestRuntime({
        carrier: 'rtc',
        stores: createInboundTestStores({
            namespace: 'inbound-dedup-retention',
            storage,
            observer: createPassThroughIndexedDbOperationObserver()
        }),
        effectWorkerId: 'inbound-dedup-retention-worker'
    });
}

/** An acknowledged copy the sender addresses to this peer as its one next hop, so a replay is answered. */
function createRetriedCopy(msgId: string): ALMessage {
    const message = createInboundTestMessage({ msgId, acknowledged: true });
    return {
        ...message,
        constraints: { ...message.constraints, expiresAtMs: Date.now() + DEADLINE_MS },
        forwarding: { ...message.forwarding, nextHopPeerIds: [INBOUND_TEST_SELF_PEER_ID] }
    };
}

/** A message deduplicated on a key it shares with every other message this helper builds. */
function createKeyedMessage(msgId: string): ALMessage {
    const message = createInboundTestMessage({ msgId });
    return {
        ...message,
        constraints: { ...message.constraints, expiresAtMs: Date.now() + DEADLINE_MS },
        qos: { dedup: { algo: 'semantic-key', opts: { semanticKey: 'room-presence' } } }
    };
}

function readAcks(runtime: InboundTestRuntime): readonly ObservedAck[] {
    return runtime.controlSends.flat().flatMap((msg): ObservedAck[] => {
        const control = parseALControlMessage(msg);
        return control?.type === 'ack'
            ? [{
                toPeerId: control.payload.toPeerId,
                ackedMsgId: control.payload.ackedMsgId,
                status: control.payload.status
            }]
            : [];
    });
}

describe('inbound dedup retention', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it.each<InboundTestStorage>(['memory', 'indexeddb'])(
        'acknowledges a replay after the window inside its deadline again without delivering it twice over %s',
        async (storage) => {
            const runtime = createRuntime(storage);
            const startedAtMs = Date.now();
            const copy = createRetriedCopy('replayed-past-the-window');
            const ack = {
                toPeerId: INBOUND_TEST_SENDER_PEER_ID,
                ackedMsgId: copy.id.msgId,
                status: 'delivered'
            };

            await runtime.runtime.ready();
            expect((await runtime.runtime.admitIncomingMessage(copy, SOURCE)).right).toEqual({
                kind: 'admitted'
            });
            await expect.poll(() => readAcks(runtime)).toEqual([ack]);

            vi.setSystemTime(startedAtMs + PAST_THE_WINDOW_MS);
            const replay = await runtime.runtime.admitIncomingMessage(copy, SOURCE);

            // The replay's answer is read first, so the replay's own batch has settled before any verdict.
            await expect.poll(() => readAcks(runtime)).toEqual([ack, ack]);
            expect(replay.right).toEqual({ kind: 'duplicate' });
            expect(runtime.delivered).toEqual(['dispatched']);
        }
    );

    it.each<InboundTestStorage>(['memory', 'indexeddb'])(
        'keeps the semantic-key window although the message deadline is longer over %s',
        async (storage) => {
            const runtime = createRuntime(storage);
            const startedAtMs = Date.now();

            await runtime.runtime.ready();
            const first = await runtime.runtime.admitIncomingMessage(
                createKeyedMessage('first'),
                SOURCE
            );
            await expect.poll(() => runtime.delivered).toEqual(['dispatched']);

            vi.setSystemTime(startedAtMs + INSIDE_THE_WINDOW_MS);
            const insideTheWindow = await runtime.runtime.admitIncomingMessage(
                createKeyedMessage('inside'),
                SOURCE
            );

            vi.setSystemTime(startedAtMs + PAST_THE_WINDOW_MS);
            const pastTheWindow = await runtime.runtime.admitIncomingMessage(
                createKeyedMessage('past'),
                SOURCE
            );

            expect([first.right, insideTheWindow.right, pastTheWindow.right]).toEqual([
                { kind: 'admitted' },
                { kind: 'duplicate' },
                { kind: 'admitted' }
            ]);
            await expect.poll(() => runtime.delivered).toEqual(['dispatched', 'dispatched']);
        }
    );
});
