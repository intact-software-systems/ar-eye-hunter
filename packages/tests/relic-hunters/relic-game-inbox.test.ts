import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import * as relicRules from '@relic-hunters/mod.ts';
import {
    createRelicGame,
    isRelicHunterEvent,
    RELIC_PROTOCOL_VERSION
} from '@relic-hunters/mod.ts';
import { decodeRelicGameCommand } from '@relic-hunters/server/relic-game-mutation-service.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createAppInboxTestResilience } from '../shared-server/rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { connectGameSession } from './relic-game-database-fixture.ts';
import { createInboxFixture, toRelicInboxTestKey } from './relic-game-inbox-fixture.ts';

describe('Relic AppInbox ownership', () => {
    it('captures one proposal outside reservation, replays the acknowledgement and refuses a changed command', async () => {
        const timings: RallarTimingEvent[] = [];
        const fixture = await createInboxFixture({ timing: (event) => timings.push(event) });
        try {
            let proposals = 0;
            const proposal = async () => {
                proposals += 1;
                // An independent read can complete here: no transaction owns the sole PGlite connection.
                expect(await fixture.repository.findGroup(fixture.ref)).toBeDefined();
                return createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
            };
            const enqueued = await fixture.inbox.enqueue({ ...fixture.command, traceId: 'trace-relic-timed-initialize' }, proposal);
            expect(proposals).toBe(1);
            expect((await fixture.data.read(fixture.ref))[0].entry).toBeNull();
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect(await fixture.inbox.wait(enqueued)).toEqual({ status: 'initialized', gameId: fixture.ref.groupId });
            const phases = timings.filter((event) => event.component === 'relic-game');
            expect(phases.map((event) => event.operation)).toEqual(['read', 'compute', 'validate', 'write']);
            expect(phases.map((event) => event.traceId)).toEqual(Array(4).fill('trace-relic-timed-initialize'));
            expect(phases.every((event) =>
                event.requestId === fixture.command.requestId &&
                event.groupId === fixture.ref.groupId && event.details?.attempt === 1 && event.status === 'ok'
            )).toBe(true);
            expect(timings.some((event) => event.component === 'app-inbox-phase' && event.operation === 'transaction')).toBe(true);
            const saved = (await fixture.data.read(fixture.ref))[0].entry;
            const replay = await fixture.inbox.enqueue(fixture.command, proposal);
            expect(await fixture.inbox.wait(replay)).toEqual({ status: 'initialized', gameId: fixture.ref.groupId });
            expect(proposals).toBe(1);
            expect(timings.filter((event) => event.component === 'relic-game')).toEqual(phases);
            expect((await fixture.data.read(fixture.ref))[0].entry).toEqual(saved);
            await expect(fixture.inbox.enqueue({ ...fixture.command, operation: 'reset' }, proposal))
                .rejects.toMatchObject({ failure: { status: 409 } });
            await expect(fixture.inbox.enqueue({
                ...fixture.command,
                actor: { ...fixture.command.actor, issuedAtEpochMs: fixture.command.actor.issuedAtEpochMs + 1 }
            }, proposal)).rejects.toMatchObject({ failure: { status: 409 } });
            expect(proposals).toBe(1);
        }
        finally {
            await fixture.storage.close();
        }
    }, 30_000);

    it('admits a command under its transport trace and publishes every effect under it', async () => {
        const fixture = await createInboxFixture();
        try {
            const proposal = async () => createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
            const ensure = await fixture.inbox.enqueue(fixture.command, proposal);
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            await fixture.inbox.wait(ensure);
            const reset = { ...fixture.command, operation: 'reset' as const, requestId: 'traced-reset', traceId: 'trace-relic-transport-command' };

            const queued = await fixture.inbox.enqueue(reset, proposal);
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect(await fixture.inbox.wait(queued)).toEqual({ status: 'applied', gameId: fixture.ref.groupId });

            const rows = await fixture.storage.sql<{ type: string; traceId: string; }[]>`
                select ri_type_id as type, ri_resource::jsonb #>> '{id,traceId}' as "traceId" from resource_inbox
                where ri_resource_id = ${reset.requestId} or (ri_type_id = 'WS_OUTBOX' and ri_resource_id like 'relic:%')
            `;
            expect(rows.map((row) => row.type).sort()).toEqual(['APP_INBOX', 'WS_OUTBOX']);
            expect(rows.map((row) => row.traceId)).toEqual([reset.traceId, reset.traceId]);
        }
        finally {
            await fixture.storage.close();
        }
    }, 30_000);

    it.each([
        '48e1ca3a-fb77-46ef-bd12-630b05a628f0',
        'ws-command:48e1ca3a-fb77-46ef-bd12-630b05a628f0:8afe7cc4-b11a-453f-a2a9-7ccce3eb0963'
    ])('initializes and replays a UUID room with request %s', async (requestId) => {
        const gameId = '17a8cf8f-bd93-41f8-994f-0650daf9f3a0';
        const fixture = await createInboxFixture({ gameId });
        try {
            const command = { ...fixture.command, requestId };
            let proposals = 0;
            const proposal = async () => {
                proposals += 1;
                return createRelicGame(gameId, gameId, fixture.nowEpochMs);
            };
            const queued = await fixture.inbox.enqueue(command, proposal);
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect(await fixture.inbox.wait(queued)).toEqual({ status: 'initialized', gameId });
            const saved = (await fixture.data.read(fixture.ref))[0].entry;
            expect(saved).not.toBeNull();
            const replay = await fixture.inbox.enqueue(command, proposal);
            expect(await fixture.inbox.wait(replay)).toEqual({ status: 'initialized', gameId });
            expect(proposals).toBe(1);
            expect((await fixture.data.read(fixture.ref))[0].entry).toEqual(saved);
        }
        finally {
            await fixture.storage.close();
        }
    }, 30_000);

    it('stores omitted move choices explicitly and rejects incomplete persisted command shapes', async () => {
        const fixture = await createInboxFixture();
        try {
            const move = { protocolVersion: RELIC_PROTOCOL_VERSION, kind: 'join-expedition' as const, gameId: fixture.ref.groupId, username: 'owner' };
            const command = { ...fixture.command, operation: 'command' as const, move };
            const proposal = async () => createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
            const queued = await fixture.inbox.enqueue(command, proposal);
            const retained = await fixture.resources.entries.findByKey(toRelicInboxTestKey(fixture));
            const stored = JSON.parse(JSON.parse(retained!.resource).payload.resource);
            expect(stored.data).toMatchObject({ move: { ...move, characterId: null } });
            expect(() => decodeRelicGameCommand(command)).toThrow();
            const replay = await fixture.inbox.enqueue({ ...command, move: { ...move, characterId: undefined } }, proposal);
            expect(await fixture.resources.entries.findByKey(toRelicInboxTestKey(fixture))).toEqual(retained);
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect(await fixture.inbox.wait(replay)).toEqual(await fixture.inbox.wait(queued));
            await expect(fixture.inbox.enqueue({ ...command, move: { ...move, username: 'another-user' } }, proposal))
                .rejects.toMatchObject({ failure: { status: 409 } });
            await fixture.inbox.enqueue({
                ...command,
                requestId: 'explicit-action-omission',
                move: {
                    protocolVersion: RELIC_PROTOCOL_VERSION,
                    kind: 'submit-action',
                    gameId: fixture.ref.groupId,
                    username: 'owner',
                    action: { kind: 'search' }
                }
            }, proposal);
            const action = await fixture.resources.entries.findByKey(toRelicInboxTestKey(fixture, 'explicit-action-omission'));
            expect(JSON.parse(JSON.parse(action!.resource).payload.resource).data).toMatchObject({
                move: { action: { kind: 'search', targetRoomId: null, targetPlayerId: null } }
            });
        }
        finally {
            await fixture.storage.close();
        }
    }, 30_000);

    it.each(['command', 'topic', 'request', 'dispatched-operation', 'sender', 'proposal'])(
        'refuses a corrupt stored %s binding before replay or proposal capture',
        async (binding) => {
            const fixture = await createInboxFixture();
            try {
                let proposals = 0;
                const proposal = async () => {
                    proposals += 1;
                    return createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
                };
                const queued = await fixture.inbox.enqueue(fixture.command, proposal);
                const entry = await fixture.resources.entries.findByKey(toRelicInboxTestKey(fixture));
                if (entry === null) {
                    throw new Error('Expected queued Relic command');
                }
                const message = JSON.parse(entry.resource);
                const enqueue = JSON.parse(message.payload.resource);
                if (binding === 'command') {
                    enqueue.authority.command.actor.sessionId = 'another-session';
                }
                if (binding === 'sender') {
                    enqueue.senderId = 'another-session';
                }
                if (binding === 'proposal') {
                    enqueue.authority.initial.gameId = 'another-game';
                }
                if (binding === 'topic') {
                    enqueue.topicId = 'app:another-game:mutate';
                }
                if (binding === 'request') {
                    enqueue.resourceId = 'another-request';
                }
                if (binding === 'dispatched-operation') {
                    message.payload.typeId = 'app:another-game:mutate';
                }
                message.payload.resource = JSON.stringify(enqueue);
                await fixture.storage.sql`update resource_inbox set ri_resource = ${JSON.stringify(message)}
                    where ri_topic_id = ${toRelicInboxTestKey(fixture).topicId} and fk_ext_bank_id = ${toRelicInboxTestKey(fixture).contextId}
                    and ri_resource_id = ${toRelicInboxTestKey(fixture).resourceId}`;
                await expect(fixture.inbox.enqueue(fixture.command, proposal)).rejects.toMatchObject({ code: 'app-inbox-malformed-command' });
                expect(proposals).toBe(1);
                expect((await fixture.data.read(fixture.ref))[0].entry).toBeNull();
                expect(await fixture.results.findByKey(toRelicInboxTestKey(fixture))).toBeUndefined();
            }
            finally {
                await fixture.storage.close();
            }
        },
        30_000
    );

    it.each([
        { status: 'initialized', gameId: 'another-game' },
        { status: 'applied', gameId: 'expedition-1' }
    ])('rejects a completed result with the wrong game or operation: $status $gameId', async (corrupt) => {
        const fixture = await createInboxFixture();
        try {
            const proposal = vi.fn(async () => createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs));
            const queued = await fixture.inbox.enqueue(fixture.command, proposal);
            const entry = await fixture.resources.entries.findByKey(toRelicInboxTestKey(fixture));
            if (entry === null) {
                throw new Error('Expected the queued Relic request');
            }
            await fixture.results.replace({ ...entry, status: 'COMPLETED', resource: JSON.stringify(corrupt) });
            await fixture.storage.sql`update resource_inbox set ri_status = 'COMPLETED'
                where ri_topic_id = ${toRelicInboxTestKey(fixture).topicId} and fk_ext_bank_id = ${toRelicInboxTestKey(fixture).contextId}
                and ri_resource_id = ${toRelicInboxTestKey(fixture).resourceId}`;
            const resultBefore = await fixture.results.findByKey(toRelicInboxTestKey(fixture));
            const replay = await fixture.inbox.enqueue(fixture.command, proposal);
            await expect(fixture.inbox.wait(replay)).rejects.toMatchObject({
                failure: { code: 'app-inbox-result-corrupt', status: 500 }
            });
            expect(proposal).toHaveBeenCalledTimes(1);
            expect(await fixture.results.findByKey(toRelicInboxTestKey(fixture))).toEqual(resultBefore);
            expect((await fixture.data.read(fixture.ref))[0].entry).toBeNull();
            expect(await fixture.storage.sql`select ri_resource_id from resource_inbox where ri_type_id = 'WS_OUTBOX'`).toHaveLength(0);
        }
        finally {
            await fixture.storage.close();
        }
    }, 30_000);

    it('publishes an expected rule refusal privately and leaves unexpected rule faults to AppInbox', async () => {
        const fixture = await createInboxFixture();
        try {
            await connectGameSession(fixture, fixture.owner);
            const command = {
                ...fixture.command,
                operation: 'command' as const,
                requestId: 'invalid-action',
                move: {
                    protocolVersion: RELIC_PROTOCOL_VERSION,
                    kind: 'submit-action' as const,
                    gameId: fixture.ref.groupId,
                    username: 'owner',
                    action: { kind: 'search' as const }
                }
            };
            const proposal = async () => createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
            const refused = await fixture.inbox.enqueue(command, proposal);
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect(await fixture.inbox.wait(refused)).toMatchObject({ status: 'refused', code: 'rule-refused', httpStatus: 409 });
            const published = await fixture.storage.sql<{ ri_resource: string; }[]>`
                select ri_resource from resource_inbox where ri_type_id = 'WS_OUTBOX'`;
            expect(published).toHaveLength(1);
            const message = JSON.parse(published[0].ri_resource);
            expect(message.targets).toMatchObject({
                scope: 'principal',
                groupRef: fixture.ref,
                principalRef: { applicationId: fixture.ref.applicationId, workspaceId: fixture.ref.workspaceId, principalId: fixture.owner.clientId }
            });
            expect(JSON.parse(message.payload.resource)).toMatchObject({ kind: 'command-refused' });
            expect(isRelicHunterEvent(JSON.parse(message.payload.resource))).toBe(true);
            // Fault injection at the owned rule engine boundary checks failure classification, not its algorithm.
            const broken = await fixture.inbox.enqueue({ ...command, requestId: 'unexpected-rule-fault' }, proposal);
            const fault = vi.spyOn(relicRules, 'applyRelicCommand').mockImplementation(() => {
                throw new TypeError('unexpected rule fault');
            });
            try {
                for (let pass = 0; pass < 20; pass += 1) {
                    fixture.nowEpochMs += 1;
                    await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
                    if ((await fixture.resources.entries.findByKey(toRelicInboxTestKey(fixture, 'unexpected-rule-fault')))?.dequeueAudit.attempts === 20) {
                        break;
                    }
                }
            }
            finally {
                fault.mockRestore();
            }
            await expect(fixture.inbox.wait(broken)).rejects.toMatchObject({
                failure: { code: 'app-inbox-retry-exhausted', status: 503, retry: { attempts: 20 } }
            });
            expect((await fixture.data.read(fixture.ref))[0].entry).toBeNull();
            expect(await fixture.storage.sql`select ri_resource from resource_inbox where ri_type_id = 'WS_OUTBOX'`).toEqual(published);
        }
        finally {
            await fixture.storage.close();
        }
    }, 30_000);

    it('returns a real CAS conflict to QueueBox and rechecks room policy on redelivery', async () => {
        const timings: RallarTimingEvent[] = [];
        const fixture = await createInboxFixture({ timing: (event) => timings.push(event) });
        try {
            let proposals = 0;
            const queued = await fixture.inbox.enqueue(fixture.command, async () => {
                proposals += 1;
                return createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
            });
            const originalRead = fixture.repository.readSnapshotWithAuthorityGuard.bind(fixture.repository);
            vi.spyOn(fixture.repository, 'readSnapshotWithAuthorityGuard').mockImplementationOnce(async (ref) => {
                const observed = await originalRead(ref);
                const current = await fixture.repository.findGroupEntry(ref);
                if (!current) {
                    throw new Error('Expected the active room');
                }
                await fixture.repository.updateGroup(
                    { ...current.value, status: 'archived', archived: current.value.updated, deleted: null },
                    current.entry.revision
                );
                return observed;
            });
            const resilience = createAppInboxTestResilience(0);
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
            expect(
                timings.filter((event) => event.component === 'relic-game' && event.details?.attempt === 1)
                    .map((event) => [event.operation, event.status])
            )
                .toEqual([['read', 'ok'], ['compute', 'ok'], ['validate', 'ok'], ['write', 'error']]);
            // One draining pass can serve NEW then RETRY; each distinct delivery still executes one complete attempt.
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
            expect(await fixture.inbox.wait(queued)).toMatchObject({ status: 'refused', code: 'room-unavailable', httpStatus: 404 });
            expect((await fixture.resources.entries.findByKey(toRelicInboxTestKey(fixture)))?.dequeueAudit.attempts).toBe(2);
            expect(
                timings.filter((event) => event.component === 'relic-game' && event.details?.attempt === 2)
                    .map((event) => event.operation)
            ).toEqual(['read', 'compute', 'validate', 'write']);
            expect(proposals).toBe(1);
            expect((await fixture.data.read(fixture.ref))[0].entry).toBeNull();
            expect(await fixture.storage.sql`select ri_resource_id from resource_inbox where ri_type_id = 'WS_OUTBOX'`).toHaveLength(0);
        }
        finally {
            await fixture.storage.close();
        }
    }, 30_000);

    it('exhausts twenty outer deliveries without an inner retry or partial save', async () => {
        const timings: RallarTimingEvent[] = [];
        const fixture = await createInboxFixture({ timing: (event) => timings.push(event) });
        try {
            const queued = await fixture.inbox.enqueue(
                fixture.command,
                async () => createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs)
            );
            const originalRead = fixture.repository.readSnapshotWithAuthorityGuard.bind(fixture.repository);
            vi.spyOn(fixture.repository, 'readSnapshotWithAuthorityGuard').mockImplementation(async (ref) => {
                const observed = await originalRead(ref);
                const current = await fixture.repository.findGroupEntry(ref);
                if (!current) {
                    throw new Error('Expected the active room');
                }
                await fixture.repository.updateGroup(current.value, current.entry.revision);
                return observed;
            });
            const resilience = createAppInboxTestResilience(0);
            for (let pass = 0; pass < 20; pass += 1) {
                fixture.nowEpochMs += 1;
                await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
                if ((await fixture.resources.entries.findByKey(toRelicInboxTestKey(fixture)))?.dequeueAudit.attempts === 20) {
                    break;
                }
            }
            expect((await fixture.resources.entries.findByKey(toRelicInboxTestKey(fixture)))?.dequeueAudit.attempts).toBe(20);
            for (let attempt = 1; attempt <= 20; attempt += 1) {
                const phases = timings.filter((event) => event.component === 'relic-game' && event.details?.attempt === attempt);
                expect(phases.map((event) => event.operation)).toEqual(['read', 'compute', 'validate', 'write']);
                expect(phases.at(-1)?.status).toBe('error');
            }
            await expect(fixture.inbox.wait(queued)).rejects.toMatchObject({
                failure: { code: 'app-inbox-retry-exhausted', status: 503, retry: { kind: 'exhausted', attempts: 20 } }
            });
            expect((await fixture.data.read(fixture.ref))[0].entry).toBeNull();
            expect(await fixture.storage.sql`select ri_resource_id from resource_inbox where ri_type_id = 'WS_OUTBOX'`).toHaveLength(0);
        }
        finally {
            await fixture.storage.close();
        }
    }, 30_000);

    it('rolls back the game save and publication if durable completion fails', async () => {
        const fixture = await createInboxFixture();
        try {
            await fixture.storage.sql`alter table resource_inbox_results add constraint fail_relic_success check (ris_status <> 'COMPLETED')`;
            const enqueued = await fixture.inbox.enqueue(
                { ...fixture.command, operation: 'reset' },
                async () => createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs)
            );
            const before = await fixture.repository.findGroupEntry(fixture.ref);
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await fixture.data.read(fixture.ref))[0].entry).toBeNull();
            expect(await fixture.repository.findGroupEntry(fixture.ref)).toEqual(before);
            expect(await fixture.storage.sql`select ri_resource_id from resource_inbox where ri_type_id = 'WS_OUTBOX'`).toHaveLength(0);
            expect((await fixture.results.findByKey(toRelicInboxTestKey(fixture)))?.status).not.toBe('COMPLETED');
        }
        finally {
            await fixture.storage.close();
        }
    }, 30_000);
});
