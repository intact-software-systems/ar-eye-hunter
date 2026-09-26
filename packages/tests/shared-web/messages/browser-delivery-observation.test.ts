import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

afterEach(() => vi.useRealTimers());

describe('browser session delivery observation', () => {
    it('retains the original waiter and acknowledged evidence beyond the deadline across transport epochs', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const fixture = createObservation();
        const handle = fixture.registry.open(createMessage('retained'), 'ws');
        const waiting = handle.wait();
        const oldEpoch = fixture.feed.open({ ws: fixture.owner.settle, rtc: fixture.owner.settle });
        fixture.feed.close();
        const nextEpoch = fixture.feed.open({ ws: fixture.owner.settle, rtc: fixture.owner.settle });
        oldEpoch.settlements.ws({ kind: 'cancelled', msgId: handle.msgId, carrier: 'ws', atMs: 0 });
        expect(handle.lifecycle().state).toBe('submitted');
        nextEpoch.settlements.ws({
            kind: 'acknowledgement',
            msgId: handle.msgId,
            carrier: 'ws',
            atMs: 0,
            mode: 'hop',
            confirmedHopPeerIds: ['current-hop'],
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: ['current-hop'],
            confirmedRecipientPeerIds: ['current-hop'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
        expect((await waiting).lifecycle.state).toBe('acknowledged');
        await vi.advanceTimersByTimeAsync(101);
        expect(handle.lifecycle()).toMatchObject({
            state: 'acknowledged',
            evidence: { confirmedHopPeerIds: ['current-hop'] }
        });
        expect(vi.getTimerCount()).toBe(0);
        fixture.feed.close();
    });

    it('releases only the matching session and ignores stale invalidation after replacement', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const fixture = createObservation();
        const oldHandle = fixture.registry.open(createMessage('old'), 'ws');
        const oldWaiting = oldHandle.wait();
        const replacement = { ...fixture.session, sessionId: 'replacement' };
        fixture.owner.beginSession(replacement);
        expect((await oldWaiting).lifecycle.state).toBe('unobservable');
        const currentHandle = fixture.registry.open(createMessage('current'), 'rtc');
        const currentWaiting = currentHandle.wait();
        fixture.owner.endSession(fixture.session);
        expect(currentHandle.lifecycle().state).toBe('submitted');
        fixture.owner.endSession(replacement);
        expect((await currentWaiting).lifecycle.state).toBe('unobservable');
        expect(vi.getTimerCount()).toBe(0);
    });
});

interface DeliveryObservationFixture {
    readonly registry: BrowserRallarDeliveryRegistry;
    readonly feed: BrowserDeliverySettlements;
    readonly owner: BrowserSessionDeliveries;
    readonly session: AuthSession;
}

function createObservation(): DeliveryObservationFixture {
    const registry = new BrowserRallarDeliveryRegistry({ nowMs: Date.now, retainTerminalMs: 60_000, maxEntries: 512, cancel: () => {} });
    const middleware = createDefaultApiMiddlewareTestDouble();
    const feed = new BrowserDeliverySettlements();
    const owner = new BrowserSessionDeliveries(registry, { deliverySettlements: feed, readMiddleware: () => middleware });
    owner.beginSession(middleware.session);
    return { registry, feed, owner, session: middleware.session };
}

function createMessage(msgId: string): ALMessage {
    return {
        id: { v: 2, msgId, ts: 0, senderId: 'self' },
        route: { topicId: 'app.event', contextId: 'all', resourceId: msgId },
        payload: { typeId: 'app.event', contentType: 'application/json', resource: 'true' },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        constraints: { expiresAtMs: 100 }
    };
}
