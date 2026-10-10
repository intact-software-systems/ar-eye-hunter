import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

import {
    BrowserALSessionChannel,
    toBrowserALSessionKey
} from '@shared-web/browser/al-runtime/browser-al-session-channel.ts';
import { BROWSER_DELIVERY_RETENTION } from '@shared-web/browser/composition/browser-delivery-composition.ts';
import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';
import { FakeBroadcastChannel } from '../data/rallar-data-test-runtime.ts';

const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };

afterEach(() => {
    FakeBroadcastChannel.clear();
});

describe('browser delivery settlement relay', () => {
    it('relays a settlement for a message it holds no handle for once, and the holding tab applies it once', async () => {
        const wire = listenOnSessionChannel('session-1');
        const sender = createTab('session-1');
        const owner = createTab('session-1');
        const bystander = createTab('session-1');
        const handle = sender.registry.open(createMessage('durable-send'), 'ws');

        owner.epoch.settlements.ws(toAttemptStarted(handle.msgId, 'attempt-1'));
        await flushChannel();

        expect(wire.map((message) => message.kind)).toEqual(['settlement']);
        expect(handle.lifecycle().evidence.attempts.map((attempt) => attempt.attemptId)).toEqual(['attempt-1']);
        expect(bystander.registry.getHandle(handle.msgId)).toBeUndefined();
    });

    // A restored checkpoint message has no handle anywhere, so the owner relays its settlements as a durable one's.
    it('relays a checkpoint lane\'s settlement as it relays a durable lane\'s', async () => {
        const wire = listenOnSessionChannel('session-1');
        const sender = createTab('session-1');
        const owner = createTab('session-1');
        const handle = sender.registry.open(createMessage('checkpoint-send'), 'ws');

        owner.epoch.settlements.ws({ ...toAttemptStarted(handle.msgId, 'attempt-1'), lane: 'checkpoint' });
        await flushChannel();

        expect(wire.map((message) => message.kind)).toEqual(['settlement']);
        expect(handle.lifecycle().evidence.attempts.map((attempt) => attempt.attemptId)).toEqual(['attempt-1']);
    });

    // A volatile message's state lives in the tab that admitted it, and a settlement no lane stated is the
    // recording tab's own; neither reaches another tab.
    it('relays no settlement of a volatile lane and none that no lane stated', async () => {
        const wire = listenOnSessionChannel('session-1');
        const sender = createTab('session-1');
        const owner = createTab('session-1');
        const handle = sender.registry.open(createMessage('volatile-send'), 'ws');

        owner.epoch.settlements.ws({ ...toAttemptStarted(handle.msgId, 'attempt-1'), lane: 'volatile' });
        owner.epoch.settlements.ws({ kind: 'cancelled', msgId: handle.msgId, carrier: 'ws', atMs: 1 });
        await flushChannel();

        expect(wire).toEqual([]);
        expect(handle.lifecycle().state).toBe('submitted');
    });

    it('does not relay a settlement for a message it holds the handle of', async () => {
        const wire = listenOnSessionChannel('session-1');
        const sender = createTab('session-1');
        createTab('session-1');
        const handle = sender.registry.open(createMessage('own-send'), 'ws');

        sender.epoch.settlements.ws(toAttemptStarted(handle.msgId, 'attempt-1'));
        await flushChannel();

        expect(wire).toEqual([]);
        expect(handle.lifecycle().evidence.attempts).toHaveLength(1);
    });

    it('never relays to another session', async () => {
        const otherSession = createTab('session-2');
        const owner = createTab('session-1');
        const handle = otherSession.registry.open(createMessage('same-id-elsewhere'), 'ws');

        owner.epoch.settlements.ws(toAttemptStarted(handle.msgId, 'attempt-1'));
        await flushChannel();

        expect(handle.lifecycle().evidence.attempts).toEqual([]);
    });

    it('stops relaying when the connect epoch closes', async () => {
        const sender = createTab('session-1');
        const owner = createTab('session-1');
        const handle = sender.registry.open(createMessage('after-close'), 'ws');

        owner.feed.close();
        owner.epoch.settlements.ws(toAttemptStarted(handle.msgId, 'attempt-1'));
        await flushChannel();

        expect(handle.lifecycle().evidence.attempts).toEqual([]);
    });

    // Settlements are not idempotent: every settlement after a terminal state counts as late, so two
    // receiving tabs and a relay must still apply each one once.
    it('applies a relayed terminal settlement and each late one once', async () => {
        const sender = createTab('session-1');
        const owner = createTab('session-1');
        createTab('session-1');
        const handle = sender.registry.open(createMessage('expired-then-late'), 'ws');

        owner.epoch.settlements.ws({
            kind: 'expired',
            msgId: handle.msgId,
            carrier: 'ws',
            atMs: 2,
            detail: 'deadline',
            lane: 'durable'
        });
        owner.epoch.settlements.ws(toAttemptStarted(handle.msgId, 'attempt-late'));
        owner.epoch.settlements.ws(toAttemptStarted(handle.msgId, 'attempt-later'));
        await flushChannel();

        expect(handle.lifecycle()).toMatchObject({ state: 'expired', lateSettlementCount: 2 });
    });
});

interface RelayTab {
    readonly registry: BrowserRallarDeliveryRegistry;
    readonly feed: BrowserDeliverySettlements;
    readonly epoch: BrowserDeliverySettlements.Epoch;
}

/** One tab of a session: its own registry and connect epoch, joined to the others only by the session channel. */
function createTab(sessionId: string): RelayTab {
    const registry = new BrowserRallarDeliveryRegistry({ nowMs: () => 0, ...BROWSER_DELIVERY_RETENTION, cancel: () => {} });
    const middleware = createDefaultApiMiddlewareTestDouble();
    const feed = new BrowserDeliverySettlements();
    const sessionDeliveries = new BrowserSessionDeliveries(registry, {
        deliverySettlements: feed,
        readMiddleware: () => middleware,
        readRtcCaptureReceipt: () => undefined
    }, () => middleware.session);
    sessionDeliveries.beginSession(middleware.session);
    const observers = sessionDeliveries.observers;
    const channel = new BrowserALSessionChannel({
        scope: SCOPE,
        sessionId,
        instanceId: crypto.randomUUID(),
        openPort: (name) => new FakeBroadcastChannel(name),
        applySettlement: (settlement) => observers[settlement.carrier](settlement)
    });
    const epoch = feed.open(observers, channel);
    return { registry, feed, epoch };
}

function createMessage(msgId: string): ALMessage {
    const message = newALUnicastMessage(
        'sender-peer',
        { topicId: 'chat', resourceId: msgId, contextId: 'room' },
        'receiver-peer',
        'chat.private-text.v1',
        { text: msgId },
        { ttlMs: 60_000, qos: { ack: { algo: 'hop' } } }
    );
    return { ...message, id: { ...message.id, msgId } };
}

function toAttemptStarted(msgId: RallarMessageHandle['msgId'], attemptId: string): ALDeliverySettlement {
    return { kind: 'attempt-started', msgId, carrier: 'ws', atMs: 1, attemptId, lane: 'durable' };
}

/** The fake delivers on a microtask per receiver; one macrotask drains every delivery a post queued. */
async function flushChannel(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Every message another object posts on the session's channel, as a further tab would hear it. */
function listenOnSessionChannel(sessionId: string): readonly BrowserALSessionChannel.Message[] {
    const heard: BrowserALSessionChannel.Message[] = [];
    const listener = new FakeBroadcastChannel(`rallar-alm:${toBrowserALSessionKey(SCOPE, sessionId)}`);
    listener.onmessage = (event) => heard.push(event.data as BrowserALSessionChannel.Message);
    return heard;
}
