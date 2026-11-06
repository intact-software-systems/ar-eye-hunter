import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxClientService, type WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';
import { describe, expect, it, onTestFinished } from 'vitest';

function accountNotice(principalId = 'alice'): ALMessage {
    return {
        id: { v: 4, msgId: crypto.randomUUID(), ts: Date.now(), senderId: 'other-api-node', traceId: 'account-view' },
        route: { topicId: AppTopics.viewInvalidated, resourceId: 'change', contextId: 'all' },
        targets: { mode: 'unicast', toPeerId: principalId },
        payload: {
            typeId: AppTopics.viewInvalidated,
            contentType: 'application/json',
            resource: JSON.stringify({ version: 1, resource: 'friends', scope: null, principalId, changeId: 'change' })
        }
    };
}

interface AccountViewFixture {
    readonly service: WsQueueBoxClientService;
    readonly delivered: ALMessage[];
    replaceAccount(value: string | undefined): void;
}

function fixture(): AccountViewFixture {
    let principalId: string | undefined = 'alice';
    const delivered: ALMessage[] = [];
    const service = createDefaultWsQueueBoxClientService({
        outbox: new InMemoryQueueBox(),
        socket: new JsonWebSocketClient('ws://configured-server', createPassThroughTransportFaultPort()),
        sessionId: 'session-alice',
        serverPeerId: 'connected-api-node',
        readAuthenticatedPrincipalId: () => principalId
    });
    service.onAnyInboxMessageDo('observer', {
        onMessage: (message) => {
            delivered.push(message);
            return Promise.resolve();
        }
    });
    onTestFinished(() => service.close());
    return {
        service,
        delivered,
        replaceAccount: (value: string | undefined) => {
            principalId = value;
        }
    };
}

describe('WS client account view ingress', () => {
    it('delivers an exact current-account invalidation without rewriting its target or sender', async () => {
        const test = fixture();
        const message = accountNotice();
        await test.service.acceptIncomingMessage(message);
        await expect.poll(() => test.delivered).toEqual([message]);
    });

    it('does not turn ordinary account-addressed unicast into session traffic', async () => {
        const test = fixture();
        const other = accountNotice();
        await test.service.acceptIncomingMessage({
            ...other,
            route: { ...other.route, topicId: 'game.move' },
            payload: { ...other.payload, typeId: 'game.move' }
        });
        await test.service.acceptIncomingMessage(accountNotice('bob'));
        const valid = accountNotice();
        await test.service.acceptIncomingMessage(valid);
        await expect.poll(() => test.delivered).toEqual([valid]);
    });

    it.each([undefined, 'bob'])('does not deliver a former-account notice after authentication becomes %s', async (principalId) => {
        const test = fixture();
        test.replaceAccount(principalId);
        await test.service.acceptIncomingMessage(accountNotice());
        const sessionMessage: ALMessage = {
            ...accountNotice(),
            targets: { mode: 'unicast', toPeerId: 'session-alice' },
            route: { topicId: 'ordinary', resourceId: 'change', contextId: 'all' },
            payload: { typeId: 'ordinary', contentType: 'application/json', resource: '{}' }
        };
        await test.service.acceptIncomingMessage(sessionMessage);
        await expect.poll(() => test.delivered).toEqual([sessionMessage]);
    });

    it('stops later consumers if authentication changes during an earlier handler', async () => {
        const test = fixture();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        onTestFinished(() => release.resolve());
        test.service.onInboxMessageDo(AppTopics.viewInvalidated, {
            onMessage: async () => {
                entered.resolve();
                await release.promise;
                test.replaceAccount('bob');
            }
        });
        await test.service.acceptIncomingMessage(accountNotice());
        await entered.promise;
        release.resolve();
        const ordinary = {
            ...accountNotice(),
            targets: { mode: 'unicast' as const, toPeerId: 'session-alice' },
            route: { topicId: 'ordinary', resourceId: 'change', contextId: 'all' },
            payload: { typeId: 'ordinary', contentType: 'application/json', resource: '{}' }
        };
        await test.service.acceptIncomingMessage(ordinary);
        await expect.poll(() => test.delivered).toEqual([ordinary]);
    });
});
