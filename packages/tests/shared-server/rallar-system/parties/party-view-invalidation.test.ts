import { computeSha256CanonicalJson } from '@shared-server/rallar-system/protocol/compute-sha256-canonical-json.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { describe, expect, it, vi } from 'vitest';
import type { ResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createRuntime, ref } from './party-service-fixture.ts';

async function readNotices(storage: ResourceInboxTestStorage): Promise<readonly ALMessage[]> {
    const rows = await storage.sql<readonly { ri_resource: string; }[]>`
        select ri_resource from resource_inbox where ri_topic_id = 'view.invalidated' order by ri_resource_id`;
    return rows.map((row) => JSON.parse(row.ri_resource));
}

describe('transactional account view invalidation', () => {
    it('publishes exact private account views and clearing notices, with no duplicate replay', async () => {
        const storage = await createResourceInboxTestStorage('party_view_invalidation');
        try {
            const fixture = await createRuntime(storage, 3);
            const create = fixture.command('alice', 'create', { ref, expectedRosterRevision: null, intent: { action: 'create' } });
            await fixture.run(create);
            const created = await readNotices(storage);
            expect(created).toHaveLength(1);
            expect(JSON.parse(created[0]!.payload.resource)).toMatchObject({
                version: 1,
                resource: 'party',
                scope: { applicationId: 'game', workspaceId: 'default' },
                principalId: 'alice'
            });
            expect(created[0]!.targets).toEqual({
                mode: 'broadcast',
                scope: 'principal',
                principalRef: {
                    applicationId: 'game',
                    workspaceId: 'default',
                    principalId: 'alice'
                }
            });
            await fixture.service.mutate.submit({ command: create, traceId: 'replay' });
            expect(await readNotices(storage)).toEqual(created);
            await fixture.run(
                fixture.command('alice', 'invite', {
                    ref,
                    expectedRosterRevision: 0,
                    intent: { action: 'invite', principalId: 'bob', invitationId: 'invite-bob' }
                })
            );
            const invited = await readNotices(storage);
            expect(invited).toHaveLength(3);
            await fixture.run(fixture.command('alice', 'revoke', { ref, expectedRosterRevision: 0, intent: { action: 'revoke', invitationId: 'invite-bob' } }));
            const revoked = await readNotices(storage);
            const clearing = revoked.filter((message) => !invited.some((previous) => previous.id.msgId === message.id.msgId));
            expect(clearing.map((message) => JSON.parse(message.payload.resource).principalId).sort()).toEqual(['alice', 'bob']);
            expect(revoked.every((message) => JSON.parse(message.payload.resource).principalId !== 'carol')).toBe(true);
            expect((await fixture.parties.readAccount(ref, 'bob')).account.invitations).toEqual([]);
        }
        finally {
            await storage.close();
        }
    });

    it('notifies every changed search participant, including cancellation caused by party creation', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_view_invalidation');
        try {
            const fixture = await createRuntime(storage);
            await fixture.runMatch(fixture.matchCommand('alice', 'search-alice', { action: 'start', searchId: 'alice-search' }));
            expect((await readNotices(storage)).map((message) => JSON.parse(message.payload.resource).principalId)).toEqual(['alice']);
            await fixture.runMatch(fixture.matchCommand('bob', 'search-bob', { action: 'start', searchId: 'bob-search' }));
            const matched = await readNotices(storage);
            expect(matched).toHaveLength(3);
            await fixture.run(fixture.command('alice', 'create', { ref, expectedRosterRevision: null, intent: { action: 'create' } }));
            const cancelled = (await readNotices(storage)).filter((message) => !matched.some((previous) => previous.id.msgId === message.id.msgId));
            expect(
                cancelled.map((message) => {
                    const value = JSON.parse(message.payload.resource);
                    return `${value.resource}:${value.principalId}`;
                }).sort()
            ).toEqual(['matchmaking:alice', 'matchmaking:bob', 'party:alice']);
        }
        finally {
            await storage.close();
        }
    });
    it('rolls state and all notices back when the authentication guard loses', async () => {
        const storage = await createResourceInboxTestStorage('view_rollback');
        try {
            const fixture = await createRuntime(storage);
            const read = fixture.auth.findSessionBySessionIdEntry.bind(fixture.auth);
            vi.spyOn(fixture.auth, 'findSessionBySessionIdEntry').mockImplementationOnce(async (sessionId) => {
                const observed = await read(sessionId);
                await fixture.auth.deleteSession(fixture.sessions[0]!);
                return observed;
            });
            const command = fixture.command('alice', 'create', { ref, expectedRosterRevision: null, intent: { action: 'create' } });
            await fixture.service.mutate.enqueue({ command, traceId: 'rollback' });
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await fixture.parties.read(ref)).record).toBeNull();
            expect(await readNotices(storage)).toEqual([]);
        }
        finally {
            await storage.close();
        }
    });

    it('rolls back the state and provenance when the final outbox insertion fails', async () => {
        const storage = await createResourceInboxTestStorage('view_outbox_rollback');
        try {
            const fixture = await createRuntime(storage);
            await storage.sql`create function reject_view_outbox() returns trigger language plpgsql as
                'begin if NEW.ri_topic_id = ''view.invalidated'' then return null; end if; return NEW; end'`;
            await storage.sql`create trigger reject_view_outbox before insert on resource_inbox
                for each row execute function reject_view_outbox()`;
            const command = fixture.command('alice', 'create', { ref, expectedRosterRevision: null, intent: { action: 'create' } });
            await fixture.service.mutate.enqueue({ command, traceId: 'outbox-failure' });
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await fixture.parties.read(ref)).record).toBeNull();
            expect((await fixture.parties.readAccount(ref, 'alice')).account.partyId).toBeNull();
            expect(await fixture.runtime.findAllEntries('ws-outbox-provenance')).toEqual([]);
            expect(await readNotices(storage)).toEqual([]);
        }
        finally {
            await storage.close();
        }
    });

    it('persists expiry notices without a browser and replay does not duplicate them', async () => {
        const storage = await createResourceInboxTestStorage('view_expiry');
        try {
            const fixture = await createRuntime(storage);
            await fixture.runMatch(fixture.matchCommand('alice', 'search', { action: 'start', searchId: 'alice-search' }));
            const before = await readNotices(storage);
            fixture.clock.now += 120000;
            const scope = { applicationId: ref.applicationId, workspaceId: ref.workspaceId };
            const command = { scope, deadlineId: computeSha256CanonicalJson('search-generation'), dueAtEpochMs: fixture.clock.now };
            const admitted = await fixture.matchService.expire.enqueue({ command, traceId: 'expire' });
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await admitted.right!.wait()).right).toEqual(command);
            const after = await readNotices(storage);
            expect(after).toHaveLength(before.length + 1);
            expect((await fixture.matchmaking.readCurrent({ scope, principalId: 'alice', nowEpochMs: fixture.clock.now })).finished?.reason).toBe(
                'search-timeout'
            );
            await fixture.matchService.expire.submit({ command, traceId: 'replay' });
            expect(await readNotices(storage)).toEqual(after);
        }
        finally {
            await storage.close();
        }
    });
});
