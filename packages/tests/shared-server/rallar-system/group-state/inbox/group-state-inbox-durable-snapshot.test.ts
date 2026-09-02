import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { createCachedGroupStateService } from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createAuthorityHarness, createRoom, processAuthenticated, requireGroupStateResult, SCOPE } from './group-state-inbox-test-runtime.ts';

describe('GroupStateInbox durable snapshot reads', () => {
    it('commits against durable state even when the consumer snapshot cache cannot serve a current result', async () => {
        const harness = await createAuthorityHarness(['owner', 'alice']);
        const groupId = 'durable-result-room';
        await createRoom(harness, groupId, 'Durable result room');
        const cachedService = createCachedGroupStateService({
            durable: harness.groupStateService,
            cache: {
                findOrLoadByRef: async () => {
                    throw new Error('Consumer cache is unavailable; mutation authority must not depend on it.');
                },
                observe: () => 'advanced'
            }
        });
        const reader = new InboxQueueReader(harness.queue);
        const service = new GroupStateInboxService(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: harness.queue,
                resourceInboxResultsRepository: harness.results,
                database: harness.database,
                groupStateService: cachedService,
                resultReader: {
                    readSnapshot: cachedService.readCurrentSnapshot,
                    readEvent: cachedService.readEvent
                }
            },
            { serviceId: 'server-12345678' }
        );

        const result = requireGroupStateResult(
            await processAuthenticated({
                service,
                reader,
                authority: harness.sessions.alice,
                input: {
                    type: AppInboxType.GROUP_JOIN,
                    resourceId: 'join-durable-result-room',
                    contextId: 'durable-result-room',
                    senderId: 'alice',
                    data: {
                        scope: SCOPE,
                        groupId,
                        request: {
                            actorPrincipalId: 'alice',
                            actorSessionId: 'alice-session',
                            requestId: 'join-durable-result-room'
                        }
                    }
                }
            })
        );

        expect(result.status).toBe('ok');
        expect(result.result.snapshot.members.map((member) => member.principalId).sort()).toEqual(['alice', 'owner']);
        expect(result.result.snapshot.group.activeMemberCount).toBe(2);
        expect((await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group.activeMemberCount).toBe(2);
    });

    it('starts the durable snapshot and mutation-fact reads together', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const groupId = 'parallel-result-read-room';
        await createRoom(harness, groupId, 'Before');
        const snapshotStarted = Promise.withResolvers<void>();
        const mutationStarted = Promise.withResolvers<void>();
        const releaseReads = Promise.withResolvers<void>();
        const reader = new InboxQueueReader(harness.queue);
        const service = new GroupStateInboxService(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: harness.queue,
                resourceInboxResultsRepository: harness.results,
                database: harness.database,
                groupStateService: {
                    ...harness.groupStateService,
                    read: async (command) => {
                        mutationStarted.resolve();
                        await releaseReads.promise;
                        return await harness.groupStateService.read(command);
                    }
                },
                resultReader: {
                    readSnapshot: async (ref) => {
                        snapshotStarted.resolve();
                        await releaseReads.promise;
                        return await harness.repository.readSnapshot(ref);
                    },
                    readEvent: harness.groupStateService.readEvent
                }
            },
            { serviceId: 'server-12345678' }
        );
        const pending = processAuthenticated({
            service,
            reader,
            authority: harness.sessions.owner,
            input: {
                type: AppInboxType.GROUP_UPDATE,
                resourceId: 'parallel-result-read',
                contextId: groupId,
                senderId: 'owner',
                data: {
                    scope: SCOPE,
                    groupId,
                    request: {
                        actorPrincipalId: 'owner',
                        actorSessionId: 'owner-session',
                        requestId: 'parallel-result-read',
                        displayName: 'After'
                    }
                }
            }
        });

        const startedTogether = await Promise.race([
            Promise.all([snapshotStarted.promise, mutationStarted.promise]).then(() => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), 100))
        ]);
        releaseReads.resolve();
        const result = requireGroupStateResult(await pending);

        expect(startedTogether).toBe(true);
        expect(result.result.snapshot.group.displayName).toBe('After');
    });
});
