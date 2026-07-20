import { describe, expect, it } from 'vitest';
import {
    validatePersistedALMessage,
} from '@shared-server/rallar-system/services/al-message-persistence-validation.ts';

describe('persisted AL message validation', () => {
    it.each([
        {
            mode: 'multicast',
            targets: {
                mode: 'multicast',
                groupRef: { applicationId: 'app-1', groupId: 'room-1' },
            },
        },
        {
            mode: 'broadcast',
            targets: {
                mode: 'broadcast',
                scope: 'room',
                groupRef: { applicationId: 'app-1', groupId: 'room-1' },
            },
        },
    ])('rejects a $mode target whose group ref omits workspaceId', ({ targets }) => {
        expect(() => validatePersistedALMessage({
            id: {
                v: 2,
                msgId: 'message-1',
                ts: 1,
                senderId: 'server-1',
            },
            route: {
                topicId: 'topic-1',
                resourceId: 'resource-1',
                contextId: 'context-1',
            },
            targets,
            payload: {
                typeId: 'type-1',
                resource: '{}',
            },
        })).toThrow(/workspace/);
    });
});
