import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import {
    createRelicGame,
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES
} from '@relic-hunters/mod.ts';
import { encodeRelicGameStateAppData } from '@relic-hunters/server/encode-relic-game-state-app-data.ts';
import { captureRelicGameCommand } from '@relic-hunters/server/relic-game-mutation-service.ts';
import { createAppInboxResourceEntry } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import { newALBroadcastMessage, newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { installRelicHunterGame, type RelicHunterServer } from '../../../apps/relic-hunter-server-v1/src/relic-game-service.ts';
import { createAppInboxTestResilience } from '../shared-server/rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { connectGameSession } from './relic-game-database-fixture.ts';
import { createInboxFixture, toRelicInboxTestKey } from './relic-game-inbox-fixture.ts';

describe('Relic public application AppInbox', () => {
    it.each(['pending', 'completed'] as const)('consumes an actual canonical retained %s row without conversion or proposal work', async (status) => {
        const fixture = await createInboxFixture();
        try {
            const initial = createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs - 10);
            const command = captureRelicGameCommand(fixture.command);
            const enqueue = {
                type: 'app:relic-hunters:mutate' as const,
                topicId: 'app:relic-hunters:mutate',
                contextId: fixture.ref.groupId,
                resourceId: fixture.command.requestId,
                senderId: fixture.owner.sessionId,
                traceId: 'trace-relic-retained-row',
                data: { ...command },
                authority: {
                    command: { ...command },
                    initial: encodeRelicGameStateAppData(initial),
                    capturedAtEpochMs: fixture.nowEpochMs - 5,
                    serverPeerId: 'retained-server'
                }
            };
            const entry = createAppInboxResourceEntry(enqueue, 'retained-api', {
                creationNow: () => Temporal.Instant.fromEpochMilliseconds(fixture.nowEpochMs),
                createMessage: ({ key, enqueue: { traceId, ...retained } }) =>
                    newALUntargetedMessage(
                        'retained-api',
                        newALRoute(key.topicId, key.contextId, key.resourceId),
                        retained.type,
                        retained,
                        { traceId }
                    )
            });
            await fixture.resources.entries.writeMaterializedIfAbsentOrReplaceExpired(entry, async () => entry);
            const exact = {
                status: 'refused',
                gameId: fixture.ref.groupId,
                code: 'retained-refusal',
                message: 'Original durable refusal',
                httpStatus: 409
            } as const;
            if (status === 'completed') {
                await fixture.storage.sql`update resource_inbox set ri_status = 'COMPLETED' where ri_type_id = 'APP_INBOX'`;
                await fixture.results.replace({ ...toResourceEntryWithKey(entry.key, 'APP_INBOX', exact), status: 'COMPLETED' });
            }
            const admission = await fixture.inbox.enqueue(fixture.command, async () => {
                throw new Error('Retained admission must not generate a proposal');
            });
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect(await fixture.inbox.wait(admission)).toEqual(status === 'completed' ? exact : { status: 'initialized', gameId: fixture.ref.groupId });
            expect((await fixture.resources.entries.findByKey(entry.key))?.resource).toBe(entry.resource);
            expect((await fixture.data.read(fixture.ref))[0].entry === null).toBe(status === 'completed');
        }
        finally {
            await fixture.storage.close();
        }
    }, 30_000);

    it('returns from WS handling after durable admission and executes one delayed winner after pending replay', async () => {
        const fixture = await createInboxFixture();
        try {
            await connectGameSession(fixture, fixture.owner);
            const handlers: Parameters<RelicHunterServer['ws']['on']>[1][] = [];
            const rallar: RelicHunterServer = {
                ws: {
                    serverPeerId: 'default-qbox-server',
                    defineTopic: () => {},
                    on: (_selector, handler) => {
                        handlers.push(handler);
                    }
                }
            };
            let proposals = 0;
            installRelicHunterGame(rallar, {
                mode: 'group-policy',
                inbox: fixture.inbox,
                mutations: fixture.service,
                createInitialState: async () => {
                    proposals += 1;
                    return createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
                },
                readSession: async () => fixture.owner
            });
            const move = { protocolVersion: RELIC_PROTOCOL_VERSION, kind: 'join-expedition' as const, gameId: fixture.ref.groupId, username: 'ignored' };
            const raw = newALBroadcastMessage(
                fixture.owner.sessionId,
                newALRoute(RELIC_TOPICS.command, fixture.ref.groupId, 'join'),
                'room',
                RELIC_TYPES.command,
                move,
                { groupRef: fixture.ref }
            );
            const message = { payload: move, raw, receivedAtEpochMs: fixture.nowEpochMs };
            const context = { senderId: fixture.owner.sessionId, roomId: fixture.ref.groupId, roomRef: fixture.ref };
            await handlers[0](message, context);
            await handlers[0](message, context);
            expect(proposals).toBe(1);
            expect((await fixture.data.read(fixture.ref))[0].entry).toBeNull();
            expect(await fixture.storage.sql`select ri_status, ri_attempts::int as ri_attempts from resource_inbox where ri_type_id = 'APP_INBOX'`).toEqual([{
                ri_status: 'NEW',
                ri_attempts: 0
            }]);
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            const key = toRelicInboxTestKey(fixture, raw.id.msgId);
            expect((await fixture.resources.entries.findByKey(key))?.dequeueAudit.attempts).toBe(1);
            expect(JSON.parse((await fixture.results.findByKey(key))!.resource)).toEqual({ status: 'applied', gameId: fixture.ref.groupId });
            expect((await fixture.data.read(fixture.ref))[0].entry).not.toBeNull();
        }
        finally {
            await fixture.storage.close();
        }
    }, 30_000);

    it('retains one authoritative proposal across concurrent misses and applies only the retained winner', async () => {
        const fixture = await createInboxFixture();
        try {
            const gate = Promise.withResolvers<void>();
            let proposals = 0;
            const proposal = async () => {
                const index = ++proposals;
                if (index === 2) {
                    gate.resolve();
                }
                await gate.promise;
                return createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs + index);
            };
            const admissions = await Promise.all([
                fixture.inbox.enqueue(fixture.command, proposal),
                fixture.inbox.enqueue(fixture.command, proposal)
            ]);
            const key = toRelicInboxTestKey(fixture);
            const retained = await fixture.resources.entries.findByKey(key);
            const envelope = JSON.parse(JSON.parse(retained!.resource).payload.resource);
            expect(proposals).toBe(2);
            expect(envelope.data).toEqual(captureRelicGameCommand(fixture.command));
            expect(envelope.senderId).toBe(fixture.owner.sessionId);
            expect(envelope.authority.command).toEqual(captureRelicGameCommand(fixture.command));
            expect(envelope.authority.capturedAtEpochMs).toBe(fixture.nowEpochMs);
            expect([fixture.nowEpochMs + 1, fixture.nowEpochMs + 2]).toContain(envelope.authority.initial.createdAtEpochMs);
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect(await Promise.all(admissions.map((admission) => fixture.inbox.wait(admission)))).toEqual([
                { status: 'initialized', gameId: fixture.ref.groupId },
                { status: 'initialized', gameId: fixture.ref.groupId }
            ]);
            expect((await fixture.resources.entries.findByKey(key))?.dequeueAudit.attempts).toBe(1);
            expect((await fixture.data.read(fixture.ref))[0].entry?.value).toMatchObject({ createdAtEpochMs: envelope.authority.initial.createdAtEpochMs });
        }
        finally {
            await fixture.storage.close();
        }
    }, 30_000);

    it('uses application admission lifecycle before proposal capture or durable writes', async () => {
        const fixture = await createInboxFixture();
        try {
            fixture.appInbox.stop();
            let proposals = 0;
            await expect(fixture.inbox.execute(fixture.command, async () => {
                proposals += 1;
                return createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
            })).rejects.toMatchObject({ failure: { code: 'app-inbox-lifecycle-rejected', status: 503 } });
            expect(proposals).toBe(0);
            expect(await fixture.storage.sql`select ri_resource_id from resource_inbox where ri_type_id = 'APP_INBOX'`).toEqual([]);
            expect((await fixture.data.read(fixture.ref))[0].entry).toBeNull();
        }
        finally {
            await fixture.storage.close();
        }
    }, 30_000);
});
