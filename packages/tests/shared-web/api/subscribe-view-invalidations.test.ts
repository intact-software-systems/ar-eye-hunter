import { subscribeViewInvalidations } from '@shared-web/browser/api/subscribe-view-invalidations.ts';
import type { RallarMessage } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarWsLifecycleEvent } from '@shared-web/browser/rallar-realtime-facade.ts';
import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics, type AuthSession } from '@shared/api/api-config.ts';
import type { ViewInvalidation } from '@shared/api/view-invalidation.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { describe, expect, it, vi } from 'vitest';

const scope = { applicationId: 'game', workspaceId: 'default' };
const alice: AuthSession = { clientId: 'alice', username: 'alice', sessionId: 'session', accessToken: 'test', expiresAtEpochMs: 9999999999999 };

function fixture(resource: ViewInvalidation['resource'] = 'party') {
    let session: AuthSession | undefined = alice;
    const messages = new SynchronousNotifications<RallarMessage<unknown>>((error) => {
        throw error;
    });
    const lifecycle = new SynchronousNotifications<RallarWsLifecycleEvent>((error) => {
        throw error;
    });
    const changed = vi.fn();
    const stop = subscribeViewInvalidations({
        browser: {
            session: () => session,
            messages: { ws: { onMessage: (_selector, handler) => messages.subscribe(handler).unsubscribe } },
            ws: { onLifecycle: (listener) => lifecycle.subscribe(listener).unsubscribe }
        },
        scope,
        resource,
        changed
    });
    return {
        changed,
        stop,
        login: (next: AuthSession | undefined) => {
            session = next;
        },
        deliver: (raw: ALMessage, transport: RallarMessage<unknown>['transport'] = 'ws') =>
            messages.publishLatest({
                raw,
                transport,
                payload: JSON.parse(raw.payload.resource),
                senderId: raw.id.senderId,
                typeId: raw.payload.typeId,
                topicId: raw.route.topicId,
                contextId: raw.route.contextId,
                resourceId: raw.route.resourceId,
                traceId: raw.id.traceId,
                receivedAtEpochMs: 1,
                reply: async () => {
                    throw new Error('Invalidation has no reply');
                }
            }),
        reopen: (kind: RallarWsLifecycleEvent['kind'] = 'open') =>
            lifecycle.publishLatest({
                kind,
                atEpochMs: 2,
                status: {
                    connectState: 'connected',
                    readyState: 'open',
                    isOpen: true,
                    reconnecting: false,
                    reconnectEnabled: true,
                    reconnectAttempts: 0,
                    maxReconnectAttempts: 10,
                    reconnectExhausted: false
                }
            })
    };
}

function notice(principalId = 'alice'): ALMessage {
    const message = newALBroadcastMessage('another-api-node', newALRoute(AppTopics.viewInvalidated, 'change', 'all'), 'all', AppTopics.viewInvalidated, {
        version: 1,
        resource: 'party',
        scope,
        principalId,
        changeId: 'change'
    });
    return { ...message, targets: { mode: 'broadcast', scope: 'principal', principalRef: { ...scope, principalId } } };
}

describe('private view push subscriptions', () => {
    it('refreshes current own-account views across server nodes and stops all subscriptions', () => {
        const test = fixture();
        test.deliver(notice());
        expect(test.changed).toHaveBeenCalledTimes(1);
        test.stop();
        test.deliver(notice());
        test.reopen();
        expect(test.changed).toHaveBeenCalledTimes(1);
    });

    it('ignores wrong accounts, scopes, resources, malformed envelopes and non-WS delivery', () => {
        const test = fixture();
        const valid = notice();
        test.deliver(notice('bob'));
        test.deliver(valid, 'rtc');
        test.deliver({ ...valid, targets: { mode: 'broadcast', scope: 'all' } });
        for (const replacement of [{ scope: { ...scope, workspaceId: 'other' } }, { resource: 'matchmaking' }, { unexpected: true }]) {
            test.deliver({ ...valid, payload: { ...valid.payload, resource: JSON.stringify({ ...JSON.parse(valid.payload.resource), ...replacement }) } });
        }
        expect(test.changed).not.toHaveBeenCalled();
        test.login({ ...alice, clientId: 'bob' });
        test.deliver(valid);
        test.deliver(notice('bob'));
        expect(test.changed).toHaveBeenCalledTimes(1);
        test.login(undefined);
        test.deliver(notice('bob'));
        expect(test.changed).toHaveBeenCalledTimes(1);
        test.stop();
    });

    it('recovers on socket reopen and server subscriber resync without accepting malformed resync', () => {
        const test = fixture();
        test.reopen();
        const resync = newALBroadcastMessage('api', newALRoute(AppTopics.viewResync, 'resync', 'all'), 'all', AppTopics.viewResync, { version: 1 });
        test.deliver(resync);
        expect(test.changed).toHaveBeenCalledTimes(2);
        test.deliver({ ...resync, payload: { ...resync.payload, resource: '{"version":2}' } });
        test.deliver(resync, 'rtc');
        test.login(undefined);
        test.reopen();
        test.deliver(resync);
        expect(test.changed).toHaveBeenCalledTimes(2);
        test.stop();
    });
});

it('refreshes after initial connection attachment even when the socket opened before lifecycle listeners attached', () => {
    const test = fixture();
    test.reopen('connected');
    expect(test.changed).toHaveBeenCalledTimes(1);
    test.stop();
});

it('receives global friends list changes and only same-scope friends presence hints', () => {
    const test = fixture('friends');
    const initial = notice();
    const global = {
        ...initial,
        targets: { mode: 'unicast' as const, toPeerId: 'alice' },
        payload: {
            ...initial.payload,
            resource: JSON.stringify({ version: 1, resource: 'friends', scope: null, principalId: 'alice', changeId: 'global' })
        }
    };
    test.deliver(global);
    expect(test.changed).toHaveBeenCalledTimes(1);
    test.deliver({
        ...initial,
        payload: { ...initial.payload, resource: JSON.stringify({ version: 1, resource: 'friends', scope, principalId: 'alice', changeId: 'presence' }) }
    });
    expect(test.changed).toHaveBeenCalledTimes(2);
    const other = { ...scope, applicationId: 'other-game' };
    test.deliver({
        ...initial,
        targets: { mode: 'broadcast', scope: 'principal', principalRef: { ...other, principalId: 'alice' } },
        payload: {
            ...initial.payload,
            resource: JSON.stringify({ version: 1, resource: 'friends', scope: other, principalId: 'alice', changeId: 'presence-elsewhere' })
        }
    });
    test.login({ ...alice, clientId: 'bob' });
    test.deliver(global);
    expect(test.changed).toHaveBeenCalledTimes(2);
    test.stop();
});
