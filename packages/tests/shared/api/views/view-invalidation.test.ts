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
