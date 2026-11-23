import { GROUP_SESSION_INTENTS_NAMESPACE, groupSessionIntentKey } from '@shared-server/rallar-system/group-state/schedule/group-session-intent-storage.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { decodeViewInvalidationMessage } from '@shared/api/views/view-invalidation.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { expect, it } from 'vitest';
import { commitRetention, createRetentionDatabaseFixture, prepareRetention, RETENTION_REF, seedRetentionRoom } from './group-retention-database-fixture.ts';

it('archives and retires scheduled rooms with redacted notices to retained private intents in the same transaction', async () => {
    const fixture = await createRetentionDatabaseFixture();
    try {
        await seedRetentionRoom(fixture);
        const group = (await fixture.repository.findGroupEntry(RETENTION_REF))!;
        await fixture.repository.updateGroup({
            ...group.value,
            maxMembers: 4,
            metadata: {
                ...group.value.metadata,
                rallarRoomClocks: [{
                    name: 'court', status: 'scheduled', revision: 1, elapsedThroughEpochMs: 100,
                    phases: [{ phase: 'first', startsAtEpochMs: 100 }]
                }],
                rallarSessionSchedule: {
                    revision: 2,
                    startsAtEpochMs: fixture.nowEpochMs,
                    cancelledAtEpochMs: fixture.nowEpochMs
                }
            }
        }, group.entry.revision);
        await fixture.runtime.upsert({
            namespace: GROUP_SESSION_INTENTS_NAMESPACE,
            key: groupSessionIntentKey(RETENTION_REF, 'needs-confirmation'),
            value: JSON.stringify({ ...RETENTION_REF, principalId: 'needs-confirmation', reviewedScheduleRevision: 1 }),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        });
        await commitRetention(fixture, (await prepareRetention(fixture, 'observe-empty')).computed);
        fixture.nowEpochMs += 1001;
        const archive = (await prepareRetention(fixture, 'archive')).computed;
        expect(archive.outcome).toBe('write');
        await commitRetention(fixture, archive);
        expect((await fixture.repository.findGroup(RETENTION_REF))?.status).toBe('archived');
        expect(await fixture.repository.findSessionIntentEntry(RETENTION_REF, 'needs-confirmation')).toBeDefined();
        fixture.nowEpochMs += 604800000;
        const retire = (await prepareRetention(fixture, 'retire')).computed;
        await commitRetention(fixture, retire);
        expect(await fixture.repository.findSessionIntentEntry(RETENTION_REF, 'needs-confirmation')).toBeUndefined();
        const rows = await fixture.storage.sql<
            readonly { ri_resource: string; }[]
        >`select ri_resource from resource_inbox where ri_topic_id = 'view.invalidated'`;
        const notices = rows.map(({ ri_resource }) => decodeViewInvalidationMessage(decodePersistedALMessageValue(JSON.parse(ri_resource))));
        expect(notices.filter((notice) => notice.principalId === 'needs-confirmation')).toHaveLength(2);
        expect(notices.filter(notice => notice.resource === 'sessions').every(notice => !('groupId' in notice))).toBe(true);
        expect(notices.filter(notice => notice.resource === 'room-program')).toEqual([
            expect.objectContaining({ principalId: 'owner', groupId: RETENTION_REF.groupId, reason: 'access-changed' })
        ]);
    }
    finally {
        await fixture.storage.close();
    }
});

it('archives a temporary lobby with its exclusive seat release and private notice in one write', async () => {
    const fixture = await createRetentionDatabaseFixture();
    try {
        await seedRetentionRoom(fixture, RETENTION_REF, { returnWindowMs: 120000, claimWindowMs: 60000 });
        expect(await fixture.repository.findLobbyCommitmentEntry(RETENTION_REF, 'owner')).toBeDefined();
        await commitRetention(fixture, (await prepareRetention(fixture, 'observe-empty')).computed);
        fixture.nowEpochMs += 1000;
        const archive = (await prepareRetention(fixture, 'archive')).computed;
        await commitRetention(fixture, archive);
        expect((await fixture.repository.findGroup(RETENTION_REF))?.status).toBe('archived');
        expect(await fixture.repository.findLobbyCommitmentEntry(RETENTION_REF, 'owner')).toBeUndefined();
        expect(await fixture.repository.findGroupLobbyEntry(RETENTION_REF)).toBeUndefined();
        const rows = await fixture.storage.sql<readonly { ri_resource: string }[]>
            `select ri_resource from resource_inbox where ri_topic_id = 'view.invalidated'`;
        const lobbyNotices = rows.map(row => decodeViewInvalidationMessage(decodePersistedALMessageValue(JSON.parse(row.ri_resource))))
            .filter(notice => notice.resource === 'room-lobby');
        expect(lobbyNotices.map(notice => notice.principalId)).toEqual(['owner', 'owner']);
    }
    finally {
        await fixture.storage.close();
    }
});
