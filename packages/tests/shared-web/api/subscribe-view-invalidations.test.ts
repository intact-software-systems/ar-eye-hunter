import { subscribeViewInvalidations } from '@shared-web/browser/api/subscribe-view-invalidations.ts';
import type { RallarMessageTransport } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarWsLifecycleEvent } from '@shared-web/browser/rallar-realtime-facade.ts';
import {
    newALBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { AppTopics, type AuthSession } from '@shared/api/api-config.ts';
import type { ViewInvalidation } from '@shared/api/views/view-invalidation.ts';
import {
    describe,
    expect,
    it,
    vi,
    type Mock
} from 'vitest';
import { ViewPushBrowser } from './view-push-browser.ts';

const scope = { applicationId: 'game', workspaceId: 'default' };
const alice: AuthSession = { clientId: 'alice', username: 'alice', sessionId: 'session', accessToken: 'test', expiresAtEpochMs: 9999999999999 };

interface InvalidationFixture {
    readonly changed: Mock<() => void>;
    stop(): void;
    login(next: AuthSession | undefined): void;
    deliver(raw: ALMessage, transport?: RallarMessageTransport): void;
    reopen(kind?: RallarWsLifecycleEvent['kind']): void;
}

function fixture(resource: ViewInvalidation['resource'] = 'party'): InvalidationFixture {
    let session: AuthSession | undefined = alice;
    const browser = new ViewPushBrowser(() => session);
    const changed = vi.fn();
    const stop = subscribeViewInvalidations({ browser, scope, resource, changed });
    return {
        changed,
        stop,
        login: (next: AuthSession | undefined) => {
            session = next;
        },
        deliver: (raw, transport) => browser.deliver(raw, transport),
        reopen: (kind) => browser.reopen(kind)
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

it('refreshes public catalog readers only while authenticated in the exact game and workspace', () => {
    const test = fixture('tournament-catalog');
    const initial = notice();
    const publicNotice = { version: 1, resource: 'tournament-catalog', scope, principalId: null, changeId: 'opaque' };
    const message: ALMessage = {
        ...initial,
        route: { ...initial.route, contextId: scope.applicationId },
        targets: { mode: 'broadcast', scope: 'world' },
        payload: { ...initial.payload, resource: JSON.stringify(publicNotice) }
    };
    test.deliver(message);
    expect(test.changed).toHaveBeenCalledTimes(1);
    test.deliver({ ...message, payload: { ...message.payload, resource: JSON.stringify({ ...publicNotice, scope: { ...scope, workspaceId: 'other' } }) } });
    test.deliver(message, 'rtc');
    test.login(undefined);
    test.deliver(message);
    expect(test.changed).toHaveBeenCalledTimes(1);
    test.stop();
});
