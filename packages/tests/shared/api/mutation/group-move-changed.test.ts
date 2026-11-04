import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { decodeGroupMoveChangedMessage } from '@shared/api/mutation/group-move-changed.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { expect, it } from 'vitest';

const claim = { source: { applicationId: 'game', workspaceId: 'default', groupId: 'private-room' }, moveId: 'move-one' };
const message: ALMessage = {
    id: { v: AL_MESSAGE_ENVELOPE_VERSION, msgId: 'notice', ts: 1, senderId: 'server', traceId: 'trace' },
    route: toAppQueueKey({ topicId: AppTopics.groupMoveChanged, resourceId: 'notice', contextId: 'app=game:ws=default:group=private-room' }),
    targets: { mode: 'broadcast', scope: 'principal', principalRef: { applicationId: 'game', workspaceId: 'default', principalId: 'alice' } },
    payload: { typeId: AppTopics.groupMoveChanged, contentType: 'application/json', resource: JSON.stringify(claim) }
};

it('retains the exact existing Move Together claim and its scoped account envelope', () => {
    expect(decodeGroupMoveChangedMessage(message)).toEqual(claim);
});

it('rejects mismatched topic, type, source context, scope, target kind and injected payload fields', () => {
    const invalid: ALMessage[] = [
        { ...message, route: { ...message.route, topicId: 'app:forged' } },
        { ...message, payload: { ...message.payload, typeId: 'app:forged' } },
        { ...message, route: { ...message.route, contextId: 'app=game:ws=other:group=private-room' } },
        {
            ...message,
            targets: { mode: 'broadcast', scope: 'principal', principalRef: { applicationId: 'other', workspaceId: 'default', principalId: 'alice' } }
        },
        { ...message, targets: { mode: 'broadcast', scope: 'world' } },
        { ...message, targets: { mode: 'unicast', toPeerId: 'alice' } },
        {
            ...message,
            targets: {
                mode: 'broadcast',
                scope: 'principal',
                principalRef: { applicationId: 'game', workspaceId: 'default', principalId: 'alice' },
                groupRef: claim.source
            }
        },
        { ...message, payload: { ...message.payload, resource: JSON.stringify({ ...claim, participants: ['bob'] }) } }
    ];
    for (const envelope of invalid) {
        expect(() => decodeGroupMoveChangedMessage(envelope)).toThrow();
    }
});
