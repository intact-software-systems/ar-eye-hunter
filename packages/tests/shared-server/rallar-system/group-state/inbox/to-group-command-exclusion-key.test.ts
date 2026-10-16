import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { AppInboxType, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { createAppInboxResourceEntry } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import { toGroupCommandExclusionKey } from '@shared-server/rallar-system/group-state/inbox/to-group-command-exclusion-key.ts';
import {
    groupStateGroupStorageKey,
    groupStateScopeStorageKey
} from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createAppInboxQueueMessageFixture } from '../../app-inbox/test-support/create-app-inbox-queue-message-fixture.ts';

const SCOPE = { applicationId: 'app-1', workspaceId: 'workspace-1' };
const GROUP_ONE = { ...SCOPE, groupId: 'group-1' };

describe('toGroupCommandExclusionKey', () => {
    it('gives every caller\'s command on one group that group\'s storage key, whatever its own claim context', () => {
        const join = toEntry({
            type: AppInboxType.GROUP_JOIN,
            topicId: AppInboxType.GROUP_JOIN,
            resourceId: 'join-1',
            contextId: 'caller=alice',
            data: { scope: SCOPE, groupId: 'group-1', request: {} }
        });
        const presence = toEntry({
            type: AppInboxType.GROUP_PRESENCE_CONNECT,
            topicId: AppInboxType.GROUP_PRESENCE_CONNECT,
            resourceId: 'connect-1',
            contextId: 'session-bob',
            data: { scope: SCOPE, groupId: 'group-1', sessionId: 'session-bob', request: {} }
        });

        expect(toGroupCommandExclusionKey(join)).toBe(groupStateGroupStorageKey(GROUP_ONE));
        expect(toGroupCommandExclusionKey(presence)).toBe(groupStateGroupStorageKey(GROUP_ONE));
        expect(toGroupCommandExclusionKey(toEntry({
            type: AppInboxType.GROUP_JOIN,
            topicId: AppInboxType.GROUP_JOIN,
            resourceId: 'join-2',
            contextId: 'caller=carol',
            data: { scope: SCOPE, groupId: 'group-2', request: {} }
        }))).toBe(groupStateGroupStorageKey({ ...SCOPE, groupId: 'group-2' }));
    });

    it('keys a server-issued group command by the group storage key it runs in', () => {
        const publication = toEntry({
            type: AppInboxType.GROUP_TOPOLOGY_PUBLICATION,
            topicId: 'app-inbox.group-state',
            resourceId: 'publication-1',
            contextId: groupStateGroupStorageKey(GROUP_ONE),
            data: { commandId: 'command-1' }
        });

        expect(toGroupCommandExclusionKey(publication)).toBe(groupStateGroupStorageKey(GROUP_ONE));
    });

    // A disconnect's cleanup writes the presence of every group of its session, which only its compute reads.
    it('keys a session cleanup by its scope, which excludes every group command of that scope', () => {
        const cleanup = toEntry({
            type: AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
            topicId: 'app-inbox.group-state',
            resourceId: 'cleanup-1',
            contextId: 'session-bob',
            data: { connection: { scope: SCOPE, sessionId: 'session-bob' }, disconnectedAtEpochMs: 1, reason: 'closed' }
        });

        expect(toGroupCommandExclusionKey(cleanup)).toBe(groupStateScopeStorageKey(SCOPE));
        expect(groupStateGroupStorageKey(GROUP_ONE).startsWith(`${groupStateScopeStorageKey(SCOPE)}:`)).toBe(true);
    });

    it('leaves a command unkeyed when its group cannot form a storage key', () => {
        expect(toGroupCommandExclusionKey(toEntry({
            type: AppInboxType.GROUP_JOIN,
            topicId: AppInboxType.GROUP_JOIN,
            resourceId: 'join-4',
            contextId: 'caller=alice',
            data: { scope: SCOPE, groupId: '\uD800', request: {} }
        }))).toBeUndefined();
    });

    it('leaves commands that name no existing group unkeyed', () => {
        expect(toGroupCommandExclusionKey(toEntry({
            type: AppInboxType.GROUP_CREATE,
            topicId: AppInboxType.GROUP_CREATE,
            resourceId: 'create-1',
            contextId: 'caller=alice',
            data: { scope: SCOPE, request: {} }
        }))).toBeUndefined();
        expect(toGroupCommandExclusionKey(toEntry({
            type: AppInboxType.AUTH_WS_TICKET_ISSUE,
            resourceId: 'ticket-1',
            contextId: 'session-alice',
            data: {}
        }))).toBeUndefined();
        expect(toGroupCommandExclusionKey({
            ...toEntry({
                type: AppInboxType.GROUP_JOIN,
                topicId: AppInboxType.GROUP_JOIN,
                resourceId: 'join-3',
                contextId: 'caller=alice',
                data: { scope: SCOPE, groupId: 'group-1', request: {} }
            }),
            resource: '{'
        })).toBeUndefined();
    });
});

function toEntry(enqueue: AppInboxEnqueueInput): ResourceEntry {
    return createAppInboxResourceEntry(enqueue, 'server-1', {
        createMessage: createAppInboxQueueMessageFixture,
        creationNow: Temporal.Now.instant
    });
}
