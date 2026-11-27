import { validateBrowserReplyRoute } from '@shared-web/browser/messages/reply/validate-browser-reply-route.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { describe, expect, it } from 'vitest';

describe('validateBrowserReplyRoute', () => {
    it.each(['room.ask', 'app.ask'])('finds no issue on %s, a topic WS carries', (topicId) => {
        expect(validateBrowserReplyRoute(toRequestOnTopic(topicId))).toEqual([]);
    });

    it('names the topic with the issue a WS send of it is refused with when it starts neither app. nor room.', () => {
        expect(validateBrowserReplyRoute(toRequestOnTopic('ask'))).toEqual([
            {
                path: '$.topicId',
                code: 'invalid-ws-user-topic',
                message: 'Rallar user WS topic must start with app. or room..'
            }
        ]);
    });

    it('names a topic the platform reserves on WS', () => {
        expect(validateBrowserReplyRoute(toRequestOnTopic('rallar.ask'))).toEqual([
            { path: '$.topicId', code: 'reserved-ws-topic', message: 'Rallar WS topic is reserved: rallar.ask.' }
        ]);
    });
});

function toRequestOnTopic(topicId: string): ALMessage {
    return {
        id: { v: 4, msgId: 'request-1', ts: 10_000, senderId: 'requester-1', traceId: 'trace-reply-route' },
        route: { topicId, contextId: 'room-1', resourceId: 'ask' },
        targets: { mode: 'unicast', toPeerId: 'responder-1' },
        payload: { typeId: 'app.ask.v1', resource: '{}' }
    };
}
