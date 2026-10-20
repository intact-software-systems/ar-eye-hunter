import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { AppInboxType, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { createAppInboxResourceEntry } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import { toGroupCommandExclusionKey } from '@shared-server/rallar-system/group-state/inbox/to-group-command-exclusion-key.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createAppInboxQueueMessageFixture } from '../../app-inbox/test-support/create-app-inbox-queue-message-fixture.ts';

const SCOPE = { applicationId: 'app 1', workspaceId: 'workspace:1' };
const SCOPE_KEY = 'app=app%201:ws=workspace%3A1';
const GROUP_KEY = `${SCOPE_KEY}:group=group-1`;

describe('toGroupCommandExclusionKey', () => {
    it('keys a caller\'s aggregate command by its group and a presence command by its group session', () => {
        expect(toGroupCommandExclusionKey(joinEntry('alice', 'group-1'))).toBe(`${GROUP_KEY}:aggregate`);
        expect(toGroupCommandExclusionKey(joinEntry('carol', 'group-2'))).toBe(`${SCOPE_KEY}:group=group-2:aggregate`);
        expect(toGroupCommandExclusionKey(connectEntry('session:bob')))
            .toBe(`${GROUP_KEY}:session=session%3Abob`);
        expect(toGroupCommandExclusionKey(presenceEntry(AppInboxType.GROUP_PRESENCE_HEARTBEAT, 'session-bob')))
            .toBe(`${GROUP_KEY}:session=session-bob`);
        expect(toGroupCommandExclusionKey(presenceEntry(AppInboxType.GROUP_PRESENCE_DISCONNECT, 'session-bob')))
            .toBe(`${GROUP_KEY}:session=session-bob`);
    });

    it('keeps a server-issued command on its group key and a session cleanup on its scope key', () => {
        expect(toGroupCommandExclusionKey(publicationEntry())).toBe(GROUP_KEY);
        expect(toGroupCommandExclusionKey(cleanupEntry())).toBe(SCOPE_KEY);
    });

    // The in-process compute order only has to follow the rows two commands both guard: every join compares and sets
    // the group row, while presence guards its own session row and its principal's admission row. An AppInbox round
    // orders two keyed commands exactly when one key equals the other or is a colon-path prefix of it.
    it.each([
        {
            earlier: 'a join',
            later: 'another member\'s join',
            ordered: true,
            toEarlier: () => joinEntry('alice', 'group-1'),
            toLater: () => joinEntry('carol', 'group-1')
        },
        {
            earlier: 'a join',
            later: 'another member\'s presence connect',
            ordered: false,
            toEarlier: () => joinEntry('alice', 'group-1'),
            toLater: () => connectEntry('session-bob')
        },
        {
            earlier: 'a presence connect',
            later: 'a join',
            ordered: false,
            toEarlier: () => connectEntry('session-bob'),
            toLater: () => joinEntry('alice', 'group-1')
        },
        {
            earlier: 'a presence connect',
            later: 'a heartbeat of another session',
            ordered: false,
            toEarlier: () => connectEntry('session-bob'),
            toLater: () => presenceEntry(AppInboxType.GROUP_PRESENCE_HEARTBEAT, 'session-dave')
        },
        {
            earlier: 'a presence connect',
            later: 'a disconnect of the same session',
            ordered: true,
            toEarlier: () => connectEntry('session-bob'),
            toLater: () => presenceEntry(AppInboxType.GROUP_PRESENCE_DISCONNECT, 'session-bob')
        },
        {
            earlier: 'a session whose id extends another',
            later: 'that other session',
            ordered: false,
            toEarlier: () => connectEntry('session-bob:1'),
            toLater: () => connectEntry('session-bob')
        },
        {
            earlier: 'a join',
            later: 'a join of another group',
            ordered: false,
            toEarlier: () => joinEntry('alice', 'group-1'),
            toLater: () => joinEntry('carol', 'group-2')
        },
        {
            earlier: 'a server-issued command',
            later: 'a join',
            ordered: true,
            toEarlier: publicationEntry,
            toLater: () => joinEntry('alice', 'group-1')
        },
        {
            earlier: 'a join',
            later: 'a server-issued command',
            ordered: true,
            toEarlier: () => joinEntry('alice', 'group-1'),
            toLater: publicationEntry
        },
        {
            earlier: 'a server-issued command',
            later: 'a presence connect',
            ordered: true,
            toEarlier: publicationEntry,
            toLater: () => connectEntry('session-bob')
        },
        {
            earlier: 'a presence heartbeat',
            later: 'a server-issued command',
            ordered: true,
            toEarlier: () => presenceEntry(AppInboxType.GROUP_PRESENCE_HEARTBEAT, 'session-bob'),
            toLater: publicationEntry
        },
        {
            earlier: 'a session cleanup',
            later: 'a join',
            ordered: true,
            toEarlier: cleanupEntry,
            toLater: () => joinEntry('alice', 'group-2')
        },
        {
            earlier: 'a session cleanup',
            later: 'a presence connect',
            ordered: true,
            toEarlier: cleanupEntry,
            toLater: () => connectEntry('session-bob')
        },
        {
            earlier: 'a session cleanup',
            later: 'a server-issued command',
            ordered: true,
            toEarlier: cleanupEntry,
            toLater: publicationEntry
        },
        {
            earlier: 'a presence disconnect',
            later: 'a session cleanup',
            ordered: true,
            toEarlier: () => presenceEntry(AppInboxType.GROUP_PRESENCE_DISCONNECT, 'session-bob'),
            toLater: cleanupEntry
        }
    ])('runs $later after $earlier settles in one AppInbox round: $ordered', ({ toEarlier, toLater, ordered }) => {
        expect(isOrderedBehind(toEarlier(), toLater())).toBe(ordered);
    });

    it('leaves a command unkeyed when its group cannot form a storage key', () => {
        expect(toGroupCommandExclusionKey(joinEntry('alice', '\uD800'))).toBeUndefined();
        expect(toGroupCommandExclusionKey(connectEntry('\uD800')))
            .toBeUndefined();
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
        expect(toGroupCommandExclusionKey({ ...joinEntry('alice', 'group-1'), resource: '{' })).toBeUndefined();
    });
});

/** Whether one round computes the later command only after the earlier one settles: their keys overlap as paths. */
function isOrderedBehind(earlier: ResourceEntry, later: ResourceEntry): boolean {
    const earlierKey = toGroupCommandExclusionKey(earlier);
    const laterKey = toGroupCommandExclusionKey(later);
    if (earlierKey === undefined || laterKey === undefined) {
        throw new Error('Both commands of an ordering row must be keyed');
    }
    return earlierKey === laterKey || earlierKey.startsWith(`${laterKey}:`) || laterKey.startsWith(`${earlierKey}:`);
}

function joinEntry(callerId: string, groupId: string): ResourceEntry {
    return toEntry({
        type: AppInboxType.GROUP_JOIN,
        topicId: AppInboxType.GROUP_JOIN,
        resourceId: `join-${callerId}-${groupId}`,
        contextId: `caller=${callerId}`,
        data: { scope: SCOPE, groupId, request: {} }
    });
}

function presenceEntry(
    type:
        | typeof AppInboxType.GROUP_PRESENCE_CONNECT
        | typeof AppInboxType.GROUP_PRESENCE_HEARTBEAT
        | typeof AppInboxType.GROUP_PRESENCE_DISCONNECT,
    sessionId: string
): ResourceEntry {
    return toEntry({
        type,
        topicId: type,
        resourceId: `${type}-${sessionId}`,
        contextId: `caller=${sessionId}`,
        data: { scope: SCOPE, groupId: 'group-1', sessionId, request: {} }
    });
}

function connectEntry(sessionId: string): ResourceEntry {
    return presenceEntry(AppInboxType.GROUP_PRESENCE_CONNECT, sessionId);
}

function publicationEntry(): ResourceEntry {
    return toEntry({
        type: AppInboxType.GROUP_TOPOLOGY_PUBLICATION,
        topicId: 'app-inbox.group-state',
        resourceId: 'publication-1',
        contextId: GROUP_KEY,
        data: { commandId: 'command-1' }
    });
}

function cleanupEntry(): ResourceEntry {
    return toEntry({
        type: AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
        topicId: 'app-inbox.group-state',
        resourceId: 'cleanup-1',
        contextId: 'session-bob',
        data: { connection: { scope: SCOPE, sessionId: 'session-bob' }, disconnectedAtEpochMs: 1, reason: 'closed' }
    });
}

function toEntry(enqueue: AppInboxEnqueueInput): ResourceEntry {
    return createAppInboxResourceEntry(enqueue, 'server-1', {
        createMessage: createAppInboxQueueMessageFixture,
        creationNow: Temporal.Now.instant
    });
}
