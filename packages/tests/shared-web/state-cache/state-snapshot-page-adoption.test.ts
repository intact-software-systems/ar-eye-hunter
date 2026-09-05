import { computeGroupStateSyncEntries } from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import { browserStateCacheLifecycle } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import * as groups from '@shared/repository/group-state-snapshots-repository.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createGroupSnapshot, createWebRtcGroupManager } from './browser-state-cache-lifecycle-fixtures.ts';

describe('paged authoritative group snapshot adoption', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
        vi.spyOn(Date, 'now').mockReturnValue(1000);
    });
    afterEach(() => {
        browserStateCacheLifecycle.cancelSnapshotAssemblies();
        vi.restoreAllMocks();
    });

    it('adopts all 300 members only after the final reordered page arrives through the inbox', async () => {
        const fixture = createLargeGroupPublication();
        const receive = installInbox();
        process.stdout.write(
            'SNAPSHOT-MEASUREMENT ' +
                JSON.stringify({
                    kind: 'group',
                    members: 300,
                    envelopes: fixture.pages.length,
                    logicalPages: new Set(fixture.pages.map((message) => JSON.parse(message.payload.resource).index)).size
                }) + '\n'
        );
        expect(fixture.pages.length).toBeGreaterThan(1);
        for (const page of fixture.pages.filter((message) => JSON.parse(message.payload.resource).index !== 0).reverse()) {
            await receive(page);
        }
        await receive(fixture.pages[1]);
        expect(groups.getAllGroupStateSnapshots()).toEqual([]);
        await receive(fixture.pages[0]);
        const admitted = groups.getAllGroupStateSnapshots();
        expect(admitted).toHaveLength(1);
        expect(admitted[0].members.map((member) => member.principalId)).toEqual(fixture.memberIds);
        expect(admitted[0].activeSessions).toHaveLength(300);
    });

    it('cancels incomplete authority on connection loss and rejects a foreign page scope', async () => {
        const fixture = createLargeGroupPublication();
        const receive = installInbox();
        await receive(fixture.pages[0]);
        browserStateCacheLifecycle.cancelSnapshotAssemblies();
        for (const page of fixture.pages.filter((message) => JSON.parse(message.payload.resource).index !== 0)) {
            await receive(page);
        }
        expect(groups.getAllGroupStateSnapshots()).toEqual([]);
        const message = fixture.pages[0];
        const page = JSON.parse(message.payload.resource);
        const foreign = {
            ...message,
            payload: { ...message.payload, resource: JSON.stringify({ ...page, scope: { ...page.scope, workspaceId: 'foreign' } }) }
        };
        await expect(receive(foreign)).rejects.toThrow('another scope');
        expect(groups.getAllGroupStateSnapshots()).toEqual([]);
    });
});

function createLargeGroupPublication() {
    const memberIds = Array.from({ length: 300 }, (_, index) => `session-${String(index).padStart(3, '0')}`);
    const snapshot = createGroupSnapshot({
        groupId: 'large-room',
        applicationId: 'app',
        workspaceId: 'workspace',
        sessionIds: memberIds,
        snapshotVersion: 1
    });
    const entries = computeGroupStateSyncEntries({
        commandId: 'large-room-publication',
        aggregateRef: snapshot.group,
        acceptedCausalRevision: snapshot.causalRevision,
        audience: { kind: 'group', applicationId: 'app', workspaceId: 'workspace', resourceId: 'large-room' },
        createdAtEpochMs: 1000,
        expireAtEpochMs: 61_000,
        effects: [{ effectKind: 'member-state', payloadKind: 'snapshot', payload: snapshot }]
    }, 'api-process-1');
    return { memberIds, pages: entries.map((entry) => decodePersistedALMessage(entry.resource)), entries };
}

function installInbox(): (message: ALMessage) => Promise<void> {
    let receiver: OnMessageCallback | undefined;
    browserStateCacheLifecycle.initialise({
        inbox: {
            onAllInboxMessagesDo(callback) {
                receiver = callback;
            }
        },
        webRtcGroupManager: createWebRtcGroupManager(),
        clientData: { clientId: 'session-000', sessionId: 'session-000', isOnline: true },
        options: { scope: { applicationId: 'app', workspaceId: 'workspace' } }
    });
    return async (message) => {
        if (!receiver) {
            throw new Error('Inbox was not installed');
        }
        await receiver.onMessage(message, QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox'));
    };
}
