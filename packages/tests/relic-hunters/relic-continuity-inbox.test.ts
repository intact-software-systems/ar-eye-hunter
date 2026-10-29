import { describe, expect, it } from 'vitest';

import { createRelicGame, RELIC_PROTOCOL_VERSION, type RelicCommand } from '@relic-hunters/mod.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { createAppInboxTestResilience } from '../shared-server/rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createTestAuthSession } from '../shared-server/rallar-system/group-state/group-state-test-runtime.ts';
import { connectGameSession } from './relic-game-database-fixture.ts';
import { createInboxFixture } from './relic-game-inbox-fixture.ts';

describe('Relic continuity through AppInbox', () => {
    it.each(['leave-expedition', 'take-keeper'] as const)('refuses %s for an absent expedition without creating a proposal', async (kind) => {
        const fixture = await createInboxFixture();
        try {
            await connectGameSession(fixture, fixture.owner);
            const queued = await fixture.inbox.enqueue({
                ...fixture.command,
                operation: 'command',
                requestId: kind,
                move: { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: fixture.ref.groupId, username: 'owner', kind }
            }, async () => {
                throw new Error('Continuity must not initialize an expedition');
            });
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect(await fixture.inbox.wait(queued)).toMatchObject({ status: 'refused', code: 'expedition-unavailable', httpStatus: 409 });
            expect((await fixture.data.read(fixture.ref))[0].entry).toBeNull();
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('replays takeover and withdrawal without another save or duplicated publication', async () => {
        const fixture = await createInboxFixture();
        try {
            const guest = createTestAuthSession('guest');
            await connectGameSession(fixture, fixture.owner);
            await connectGameSession(fixture, guest);
            await apply(fixture, fixture.owner, 'join-expedition');
            await apply(fixture, guest, 'join-expedition');
            const presence = await fixture.repository.findPresenceEntry({ ...fixture.ref, sessionId: fixture.owner.sessionId });
            if (!presence) {
                throw new Error('Expected Keeper presence');
            }
            fixture.nowEpochMs += 10;
            await fixture.repository.updatePresence({ ...presence.value, expiresAtEpochMs: fixture.nowEpochMs - 1 }, presence.entry.revision);
            for (const kind of ['take-keeper', 'leave-expedition'] as const) {
                const command = await apply(fixture, guest, kind);
                const saved = (await fixture.data.read(fixture.ref))[0].entry;
                const publications = await fixture.storage
                    .sql`select ri_resource_id, ri_resource from resource_inbox where ri_type_id = 'WS_OUTBOX' order by ri_resource_id`;
                const replay = await fixture.inbox.enqueue(command, async () => {
                    throw new Error('Replay cannot capture a proposal');
                });
                expect(await fixture.inbox.wait(replay)).toEqual({ status: 'applied', gameId: fixture.ref.groupId });
                expect((await fixture.data.read(fixture.ref))[0].entry).toEqual(saved);
                expect(await fixture.storage.sql`select ri_resource_id, ri_resource from resource_inbox where ri_type_id = 'WS_OUTBOX' order by ri_resource_id`)
                    .toEqual(publications);
            }
            const snapshot = await fixture.service.readCurrentSnapshot({
                ...fixture.command,
                actor: { clientId: guest.clientId, sessionId: guest.sessionId, issuedAtEpochMs: guest.issuedAtEpochMs }
            }, 'default-qbox-server');
            expect(snapshot?.players.map((player) => player.playerId)).toEqual([fixture.owner.sessionId]);
            expect(snapshot?.events.filter((event) => event.type === 'keeper_changed')).toHaveLength(1);
            expect(snapshot?.events.filter((event) => event.type === 'player_withdrew')).toHaveLength(1);
        }
        finally {
            await fixture.storage.close();
        }
    });
});

async function apply(
    fixture: Awaited<ReturnType<typeof createInboxFixture>>,
    session: ReturnType<typeof createTestAuthSession>,
    kind: Extract<RelicCommand['kind'], 'join-expedition' | 'take-keeper' | 'leave-expedition'>
) {
    const command = {
        ...fixture.command,
        operation: 'command' as const,
        requestId: `${kind}-${session.sessionId}`,
        actor: { clientId: session.clientId, sessionId: session.sessionId, issuedAtEpochMs: session.issuedAtEpochMs },
        move: { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: fixture.ref.groupId, username: session.username, kind }
    };
    const queued = await fixture.inbox.enqueue(command, async () => createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs));
    await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
    expect(await fixture.inbox.wait(queued)).toEqual({ status: 'applied', gameId: fixture.ref.groupId });
    return command;
}
