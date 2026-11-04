import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { decodeViewInvalidation, decodeViewInvalidationMessage } from '@shared/api/views/view-invalidation.ts';
import { expect, it } from 'vitest';

const notice = { version: 1, resource: 'friends', scope: null, principalId: 'alice', changeId: 'friend-change' };
const message: ALMessage = {
    id: { v: AL_MESSAGE_ENVELOPE_VERSION, msgId: 'notice', senderId: 'server', ts: 1000, traceId: 'trace' },
    route: { topicId: AppTopics.viewInvalidated, resourceId: 'notice', contextId: 'alice' },
    targets: { mode: 'unicast', toPeerId: 'alice' },
    payload: { typeId: AppTopics.viewInvalidated, resource: JSON.stringify(notice) }
};

it('decodes account-wide friends only with its exact private account destination', () => {
    expect(decodeViewInvalidationMessage(message)).toEqual(notice);
    expect(() => decodeViewInvalidationMessage({ ...message, targets: { mode: 'unicast', toPeerId: 'bob' } })).toThrow();
    expect(() => decodeViewInvalidationMessage({ ...message, targets: { mode: 'broadcast', scope: 'all' } })).toThrow();
    expect(() =>
        decodeViewInvalidationMessage({
            ...message,
            targets: { mode: 'unicast', toPeerId: 'alice', groupRef: { applicationId: 'game', workspaceId: 'default', groupId: 'room' } }
        })
    ).toThrow();
    const scope = { applicationId: 'game', workspaceId: 'default' };
    const scoped = { ...notice, scope };
    expect(
        decodeViewInvalidationMessage({
            ...message,
            targets: { mode: 'broadcast', scope: 'principal', principalRef: { ...scope, principalId: 'alice' } },
            payload: { ...message.payload, resource: JSON.stringify(scoped) }
        })
    ).toEqual(scoped);
    expect(() => decodeViewInvalidationMessage({ ...message, payload: { ...message.payload, resource: JSON.stringify(scoped) } })).toThrow();
    expect(() => decodeViewInvalidation({ ...notice, resource: 'party' })).toThrow();
    expect(() => decodeViewInvalidation({ ...notice, resource: 'matchmaking' })).toThrow();
});

it('keeps session-view invalidations scoped to their exact account', () => {
    const scope = { applicationId: 'game', workspaceId: 'default' };
    const scoped = { ...notice, resource: 'sessions', scope };
    const targets: ALMessage['targets'] = { mode: 'broadcast', scope: 'principal', principalRef: { ...scope, principalId: 'alice' } };
    expect(decodeViewInvalidationMessage({ ...message, targets, payload: { ...message.payload, resource: JSON.stringify(scoped) } })).toEqual(scoped);
    expect(() => decodeViewInvalidation({ ...scoped, scope: null })).toThrow();
    expect(() => decodeViewInvalidationMessage({ ...message, payload: { ...message.payload, resource: JSON.stringify(scoped) } })).toThrow();
});

it('accepts only identity-free public catalog hints bound to their scoped world route', () => {
    const scope = { applicationId: 'game', workspaceId: 'default' };
    const publicNotice = { version: 1, resource: 'tournament-catalog', scope, principalId: null, changeId: 'opaque-change' };
    const broadcast: ALMessage = {
        ...message,
        route: { ...message.route, contextId: scope.applicationId },
        targets: { mode: 'broadcast', scope: 'world' },
        payload: { ...message.payload, resource: JSON.stringify(publicNotice) }
    };
    expect(decodeViewInvalidationMessage(broadcast)).toEqual(publicNotice);
    expect(() => decodeViewInvalidationMessage({ ...broadcast, route: { ...broadcast.route, contextId: 'other' } })).toThrow();
    for (const replacement of [{ resource: 'tournament' }, { resource: 'friends' }, { scope: null }, { principalId: 'alice' }, { tournamentId: 'private' }]) {
        expect(() =>
            decodeViewInvalidationMessage({ ...broadcast, payload: { ...broadcast.payload, resource: JSON.stringify({ ...publicNotice, ...replacement }) } })
        ).toThrow();
    }
});
