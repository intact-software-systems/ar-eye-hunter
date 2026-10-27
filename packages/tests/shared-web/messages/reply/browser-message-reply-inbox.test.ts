import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { BrowserMessageReplyInbox } from '@shared-web/browser/messages/reply/browser-message-reply-inbox.ts';
import type { RallarMessageReplySender } from '@shared-web/browser/messages/to-rallar-message.ts';
import type {
    BrowserWebSocketInbox,
    BrowserWebSocketInboxHandler
} from '@shared-web/browser/websocket/browser-websocket-inbox.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

const REQUEST_ID = 'request-1';
const SENTINEL = 'reply-payload-sentinel-7c1f';

describe('BrowserMessageReplyInbox', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('subscribes the WS inbox once as message-replies at order 15', () => {
        const fixture = createReplyInboxFixture();

        expect(fixture.subscribed).toEqual([{ id: 'message-replies', order: 15 }]);
        fixture.stop();
        expect(fixture.unsubscribed).toBe(1);
    });

    it('resolves the waiting request with a repliable message and emits no diagnostic', async () => {
        const fixture = createReplyInboxFixture();
        const handle = fixture.openRequest('responder-1');
        const pending = handle.awaitReply<{ text: string; }>({ timeoutMs: 1_000 });

        await fixture.deliver(toReplyMessage('reply-1', 'responder-1', REQUEST_ID));

        const outcome = await pending;
        if (outcome.status !== 'replied') {
            throw new Error(`Expected a reply, got ${outcome.status}`);
        }
        expect(outcome.reply).toMatchObject({ transport: 'ws', senderId: 'responder-1', payload: { text: SENTINEL } });
        await outcome.reply.reply({ ok: true }, { typeId: 'app.answer.v1' });
        expect(fixture.sendReply).toHaveBeenCalledWith(outcome.reply.raw, { ok: true }, { typeId: 'app.answer.v1' });
        expect(fixture.diagnostics).toEqual([]);
    });

    it('emits reply-late replied for a second distinct reply', async () => {
        const fixture = createReplyInboxFixture();
        fixture.openRequest('responder-1');
        await fixture.deliver(toReplyMessage('reply-1', 'responder-1', REQUEST_ID));

        await fixture.deliver(toReplyMessage('reply-2', 'responder-1', REQUEST_ID));

        expect(fixture.diagnostics).toEqual([{
            kind: 'reply-late',
            msgId: 'reply-2',
            replyToMsgId: REQUEST_ID,
            corrId: REQUEST_ID,
            typeId: 'app.ask.v1',
            senderId: 'responder-1',
            carrier: 'ws',
            cause: 'replied'
        }]);
    });

    it('emits reply-late unobserved for a reply to a request it never observed', async () => {
        const fixture = createReplyInboxFixture();

        await fixture.deliver(toReplyMessage('reply-1', 'responder-1', 'request-elsewhere'));

        expect(fixture.diagnostics).toEqual([expect.objectContaining({
            kind: 'reply-late',
            msgId: 'reply-1',
            replyToMsgId: 'request-elsewhere',
            cause: 'unobserved'
        })]);
    });

    it('emits reply-wrong-responder for a reply from another sender than the unicast addressed', async () => {
        const fixture = createReplyInboxFixture();
        fixture.openRequest('responder-1');

        await fixture.deliver(toReplyMessage('reply-1', 'responder-2', REQUEST_ID));

        expect(fixture.diagnostics).toEqual([{
            kind: 'reply-wrong-responder',
            msgId: 'reply-1',
            replyToMsgId: REQUEST_ID,
            corrId: REQUEST_ID,
            typeId: 'app.ask.v1',
            senderId: 'responder-2',
            carrier: 'ws',
            expectedSenderId: 'responder-1'
        }]);
    });

    it('leaves a message that is not a reply to the other handlers', async () => {
        const fixture = createReplyInboxFixture();
        const handle = fixture.openRequest('responder-1');
        const { actions: _actions, ...request } = toReplyMessage('message-1', 'responder-1', REQUEST_ID);

        await fixture.deliver(request);

        expect(fixture.diagnostics).toEqual([]);
        expect(fixture.registry.recordReply(toRepliedMessage(handle))).toEqual({ kind: 'matched' });
    });

    it('never puts the reply payload into a diagnostic', async () => {
        const fixture = createReplyInboxFixture();
        fixture.openRequest('responder-1');

        await fixture.deliver(toReplyMessage('reply-1', 'responder-2', REQUEST_ID));
        await fixture.deliver(toReplyMessage('reply-2', 'responder-1', REQUEST_ID));
        await fixture.deliver(toReplyMessage('reply-3', 'responder-1', REQUEST_ID));
        await fixture.deliver(toReplyMessage('reply-4', 'responder-1', 'request-elsewhere'));

        expect(fixture.diagnostics.map((event) => event.kind)).toEqual([
            'reply-wrong-responder',
            'reply-late',
            'reply-late'
        ]);
        expect(JSON.stringify(fixture.diagnostics)).not.toContain(SENTINEL);
        for (const event of fixture.diagnostics) {
            expect(event).not.toHaveProperty('payload');
        }
    });
});

interface ReplyInboxFixture {
    readonly registry: BrowserRallarDeliveryRegistry;
    readonly sendReply: ReturnType<typeof vi.fn<RallarMessageReplySender>>;
    readonly diagnostics: ALInboundRuntimeDiagnosticsEvent[];
    readonly subscribed: Readonly<{ id: string; order: number; }>[];
    readonly unsubscribed: number;
    openRequest(toPeerId: string): RallarMessageHandle;
    deliver(message: ALMessage): Promise<void>;
    stop(): void;
}

function createReplyInboxFixture(): ReplyInboxFixture {
    const registry = new BrowserRallarDeliveryRegistry({
        nowMs: Date.now,
        retainTerminalMs: 60_000,
        maxEntries: 512,
        cancel: () => {}
    });
    const handlers: BrowserWebSocketInboxHandler[] = [];
    const subscribed: Readonly<{ id: string; order: number; }>[] = [];
    let unsubscribed = 0;
    const wsInbox: BrowserWebSocketInbox = {
        subscribe: (handler) => {
            handlers.push(handler);
            subscribed.push({ id: handler.id, order: handler.order });
            return () => {
                unsubscribed += 1;
            };
        },
        attach: () => {},
        detach: () => {},
        isAttached: () => true
    };
    const diagnostics: ALInboundRuntimeDiagnosticsEvent[] = [];
    const sendReply = vi.fn<RallarMessageReplySender>(
        async () => await Promise.resolve(registry.open(toRequestMessage('sent-reply', 'requester-1'), 'ws'))
    );
    const inbox = new BrowserMessageReplyInbox({
        wsInbox,
        deliveries: registry,
        sendReply,
        readInboundDiagnostics: () => (event) => diagnostics.push(event)
    });
    const stop = inbox.start();
    return {
        registry,
        sendReply,
        diagnostics,
        subscribed,
        get unsubscribed() {
            return unsubscribed;
        },
        openRequest: (toPeerId) => registry.open(toRequestMessage(REQUEST_ID, toPeerId), 'ws'),
        deliver: async (message) => {
            for (const handler of handlers) {
                await handler.onMessage(message);
            }
        },
        stop
    };
}

function toRequestMessage(msgId: string, toPeerId: string): ALMessage {
    return {
        id: { v: 3, msgId, ts: 0, senderId: 'requester-1' },
        route: { topicId: 'app.ask', contextId: 'room-1', resourceId: 'resource-1' },
        targets: { mode: 'unicast', toPeerId },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'app.ask.v1', resource: '{}' }
    };
}

function toReplyMessage(msgId: string, senderId: string, replyToMsgId: string): ALMessage {
    return {
        id: { v: 3, msgId, ts: 0, senderId },
        route: { topicId: 'app.ask', contextId: 'room-1', resourceId: 'resource-1' },
        targets: { mode: 'unicast', toPeerId: 'requester-1' },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'app.ask.v1', resource: JSON.stringify({ text: SENTINEL }) },
        actions: { corrId: replyToMsgId, replyToMsgId }
    };
}

function toRepliedMessage(handle: RallarMessageHandle): Parameters<BrowserRallarDeliveryRegistry['recordReply']>[0] {
    const raw = toReplyMessage('reply-direct', 'responder-1', handle.msgId);
    return {
        transport: 'ws',
        typeId: raw.payload.typeId,
        topicId: raw.route.topicId,
        contextId: raw.route.contextId,
        resourceId: raw.route.resourceId,
        senderId: raw.id.senderId,
        payload: {},
        raw,
        receivedAtEpochMs: 0,
        reply: vi.fn()
    };
}
