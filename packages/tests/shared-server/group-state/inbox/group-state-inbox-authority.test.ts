import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { describe, expect, it, vi } from 'vitest';
import { createAppInboxTestDatabase, type AppInboxTestDatabase } from '../../app-inbox-test-database.ts';

import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';

import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';

import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import {
    AppGroupInboxService,
    AppInboxType,
    type AppInboxEnqueueInput,
    type GroupCreateAppInboxPayload,
    type GroupMemberUpsertAppInboxPayload,
    type GroupPresenceConnectAppInboxPayload,
    type GroupPresenceHeartbeatAppInboxPayload,
    type GroupUpdateAppInboxPayload
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { createGroupStateService, type GroupStateWritten } from '@shared-server/rallar-system/services/group-state-service.ts';

import type { GroupMutationReceipt } from '@shared-server/rallar-system/services/group-state-mutations.ts';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import { authSession } from '../group-state-test-runtime.ts';
import {
    createAuthorityHarness,
    createResilience,
    createRoom,
    processAuthenticated,
    requireGroupStateResult,
    SCOPE,
    TestResourceInbox,
    TestResourceInboxResults,
    waitForQueueEntry
} from './group-state-inbox-test-runtime.ts';

describe('AppGroupInboxService authenticated authority', () => {
    it('fails closed before a direct user mutation can read or write without authority', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, 'direct-missing-authority', 'Before');
        expect(Reflect.get(harness.groupStateService, 'updateGroup')).toBeUndefined();
        expect(
            (
                await harness.repository.readSnapshot({
                    ...SCOPE,
                    groupId: 'direct-missing-authority'
                })
            )?.group.displayName
        ).toBe('Before');
    });

    it('rejects a raw user inbox call without authority before enqueue', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const input: AppInboxEnqueueInput<GroupCreateAppInboxPayload> = {
            type: AppInboxType.GROUP_CREATE,
            resourceId: 'raw-missing-authority',
            contextId: 'ar-eye-hunter:default:raw-missing-authority',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                request: {
                    groupId: 'raw-missing-authority',
                    displayName: 'Must Not Exist',
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: 'owner',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'raw-missing-authority'
                }
            }
        };

        await expect(
            Reflect.apply(harness.service.processEntryUntilCompletion, harness.service, [input])
        ).rejects.toMatchObject({ status: 403 });
        expect(
            await harness.repository.readSnapshot({
                ...SCOPE,
                groupId: 'raw-missing-authority'
            })
        ).toBeUndefined();
        expect(
            (await harness.queueEntries()).filter((entry) => entry.status === EntityStatus.NEW)
        ).toHaveLength(0);
    });

    it('isolates one request id across distinct group mutation operations', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const requestId = 'shared-operation-request-001';
        const groupId = 'operation-isolation-room';
        const identity = {
            resourceId: requestId,
            contextId: 'application=ar-eye-hunter:workspace=default:group=operation-isolation-room',
            senderId: 'owner'
        } as const;
        const created = await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.owner,
            input: {
                type: AppInboxType.GROUP_CREATE,
                topicId: AppInboxType.GROUP_CREATE,
                ...identity,
                data: {
                    scope: SCOPE,
                    request: {
                        groupId,
                        displayName: 'Operation Isolation',
                        kind: 'room',
                        joinMode: 'open',
                        createdByPrincipalId: 'owner',
                        actorPrincipalId: 'owner',
                        actorSessionId: 'owner-session',
                        requestId
                    }
                }
            }
        });
        expect(requireGroupStateResult(created).status).toBe('created');

        const joined = await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.owner,
            input: {
                type: AppInboxType.GROUP_MEMBER_UPSERT,
                topicId: AppInboxType.GROUP_MEMBER_UPSERT,
                ...identity,
                data: {
                    scope: SCOPE,
                    groupId,
                    principalId: 'owner',
                    request: {
                        status: 'active',
                        actorPrincipalId: 'owner',
                        actorSessionId: 'owner-session',
                        requestId
                    }
                }
            }
        });
        expect(requireGroupStateResult(joined).status).toBe('ok');
    });

    it('rejects a dequeued user command whose authority proof has extra fields', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const input: AuthenticatedGroupMutationEnqueue = {
            type: AppInboxType.GROUP_CREATE,
            resourceId: 'raw-extra-proof',
            contextId: 'ar-eye-hunter:default:raw-extra-proof',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                request: {
                    groupId: 'raw-extra-proof',
                    displayName: 'Must Not Exist',
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: 'owner',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'raw-extra-proof'
                }
            }
        };

        const pending = harness.service.processAuthenticatedGroupEntryUntilCompletion(
            input,
            harness.sessions.owner
        );
        await waitForQueueEntry(harness.queue);
        const entry = (await harness.queueEntries()).find(
            (candidate) => candidate.status === EntityStatus.NEW
        );
        if (!entry) {
            throw new Error('Expected queued authenticated group command');
        }
        const message = JSON.parse(entry.resource) as {
            payload: { resource: string; };
        };
        const command = JSON.parse(message.payload.resource) as {
            authority: { authorityProof: Record<string, string | number>; };
        };
        command.authority.authorityProof.internalAuthority = 'expiry';
        message.payload.resource = JSON.stringify(command);
        await harness.queue.enqueue({
            ...entry,
            resource: JSON.stringify(message)
        });
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        expect((await pending).left).toContain('authenticated group mutation intent is malformed');
        expect(
            await harness.repository.readSnapshot({
                ...SCOPE,
                groupId: 'raw-extra-proof'
            })
        ).toBeUndefined();
    });

    it('rejects legacy maintenance inbox types and exposes no maintenance method', async () => {
        const harness = await createAuthorityHarness(['owner']);
        expect(Reflect.get(harness.groupStateService, 'expireExpiredPresenceSessions')).toBeUndefined();
        expect(
            Reflect.get(harness.groupStateService, 'disconnectPresenceSessionsBySessionIdWritten')
        ).toBeUndefined();

        await expect(
            Reflect.apply(harness.service.processEntryUntilCompletion, harness.service, [
                {
                    type: 'GROUP_EXPIRED_PRESENCE_SESSIONS',
                    resourceId: 'raw-expiry',
                    contextId: 'raw-expiry',
                    senderId: 'attacker',
                    data: { atEpochMs: harness.nowEpochMs }
                }
            ])
        ).rejects.toMatchObject({ status: 403 });
        expect(
            (await harness.queueEntries()).filter((entry) => entry.status === EntityStatus.NEW)
        ).toHaveLength(0);
    });

    it('rejects an attacker bearer that claims the owner actor', async () => {
        const nowEpochMs = Date.now();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const authSessions = new AuthSessionRepository(runtimeRepository);
        const owner = authSession({
            ...{ clientId: 'owner', sessionId: 'owner-session' },
            ...{ accessToken: 'owner-token', nowEpochMs }
        });
        const attacker = authSession({
            ...{ clientId: 'attacker', sessionId: 'attacker-session' },
            ...{ accessToken: 'attacker-token', nowEpochMs }
        });
        await authSessions.putSession(owner);
        await authSessions.putSession(attacker);

        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const groupStateService = createGroupStateService(
            {
                runtimeRepository,
                formationDamping: 'damped',
                serviceId: 'server-12345678',
                now: () => nowEpochMs,
                authSessionRepository: authSessions
            } as
                & Parameters<typeof createGroupStateService>[0]
                & Readonly<{
                    authSessionRepository: AuthSessionRepository;
                }>
        );
        const service = new AppGroupInboxService(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: results,
                database: createAppInboxTestDatabase(queue, results, { runtimeRepository }),
                groupStateService: groupStateService
            },
            {
                serviceId: 'server-12345678'
            }
        );

        const created = await processAuthenticated({
            service,
            reader,
            authority: owner,
            input: {
                type: AppInboxType.GROUP_CREATE,
                resourceId: 'create-authority-room',
                contextId: 'ar-eye-hunter:default:authority-room',
                senderId: owner.clientId,
                data: {
                    scope: SCOPE,
                    request: {
                        groupId: 'authority-room',
                        displayName: 'Authority Room',
                        kind: 'room',
                        joinMode: 'open',
                        createdByPrincipalId: owner.clientId,
                        actorPrincipalId: owner.clientId,
                        actorSessionId: owner.sessionId,
                        requestId: 'create-authority-room'
                    }
                }
            }
        });
        expect(requireGroupStateResult(created).status).toBe('created');

        await expect(
            processAuthenticated({
                service,
                reader,
                authority: attacker,
                input: {
                    type: AppInboxType.GROUP_UPDATE,
                    resourceId: 'forged-owner-update',
                    contextId: 'ar-eye-hunter:default:authority-room',
                    senderId: attacker.clientId,
                    data: {
                        scope: SCOPE,
                        groupId: 'authority-room',
                        request: {
                            displayName: 'Forged Name',
                            actorPrincipalId: owner.clientId,
                            actorSessionId: owner.sessionId,
                            requestId: 'forged-owner-update'
                        }
                    }
                }
            })
        ).rejects.toMatchObject({ status: 403 });
        const repository = new GroupStateRepository(runtimeRepository);
        const snapshot = await repository.readSnapshot({
            ...SCOPE,
            groupId: 'authority-room'
        });
        expect(snapshot?.group.displayName).toBe('Authority Room');
    });

    it('rejects a direct raw-service attacker that claims the owner actor', async () => {
        const harness = await createAuthorityHarness(['owner', 'attacker']);
        await createRoom(harness, 'raw-authority-room', 'Raw Authority Room');

        expect(Reflect.get(harness.groupStateService, 'updateGroup')).toBeUndefined();
        const snapshot = await harness.repository.readSnapshot({
            ...SCOPE,
            groupId: 'raw-authority-room'
        });
        expect(snapshot?.group.displayName).toBe('Raw Authority Room');
        expect(
            await harness.repository.listEvents({
                ...SCOPE,
                groupId: 'raw-authority-room'
            })
        ).toHaveLength(1);
    });

    it('rejects an attacker bearer mutating another principal presence session', async () => {
        const harness = await createAuthorityHarness(['owner', 'victim', 'attacker']);
        await createRoom(harness, 'presence-authority-room', 'Presence Authority Room');
        await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.owner,
            input: {
                type: AppInboxType.GROUP_MEMBER_UPSERT,
                resourceId: 'activate-victim',
                contextId: 'ar-eye-hunter:default:presence-authority-room',
                senderId: 'owner',
                data: {
                    scope: SCOPE,
                    groupId: 'presence-authority-room',
                    principalId: 'victim',
                    request: {
                        status: 'active',
                        actorPrincipalId: 'owner',
                        actorSessionId: 'owner-session',
                        requestId: 'activate-victim'
                    }
                }
            }
        });
        await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.victim,
            input: {
                type: AppInboxType.GROUP_PRESENCE_CONNECT,
                resourceId: 'connect-victim',
                contextId: 'ar-eye-hunter:default:presence-authority-room',
                senderId: 'victim',
                data: {
                    scope: SCOPE,
                    groupId: 'presence-authority-room',
                    sessionId: 'victim-session',
                    request: {
                        principalId: 'victim',
                        generationId: 'victim-generation',
                        connectedAtEpochMs: harness.nowEpochMs,
                        lastHeartbeatAtEpochMs: harness.nowEpochMs,
                        expiresAtEpochMs: harness.nowEpochMs + 60_000,
                        actorPrincipalId: 'victim',
                        actorSessionId: 'victim-session',
                        requestId: 'connect-victim'
                    }
                }
            }
        });

        await expect(
            processAuthenticated({
                service: harness.service,
                reader: harness.reader,
                authority: harness.sessions.attacker,
                input: {
                    type: AppInboxType.GROUP_PRESENCE_HEARTBEAT,
                    resourceId: 'forged-victim-heartbeat',
                    contextId: 'ar-eye-hunter:default:presence-authority-room',
                    senderId: 'attacker',
                    data: {
                        scope: SCOPE,
                        groupId: 'presence-authority-room',
                        sessionId: 'victim-session',
                        request: {
                            principalId: 'victim',
                            generationId: 'victim-generation',
                            lastHeartbeatAtEpochMs: harness.nowEpochMs + 1_000,
                            expiresAtEpochMs: harness.nowEpochMs + 61_000,
                            actorPrincipalId: 'victim',
                            actorSessionId: 'victim-session',
                            requestId: 'forged-victim-heartbeat'
                        }
                    }
                }
            })
        ).rejects.toMatchObject({ status: 403 });
        expect(
            await harness.repository.findPresenceSession({
                ...SCOPE,
                groupId: 'presence-authority-room',
                sessionId: 'victim-session'
            })
        ).toMatchObject({
            lastHeartbeatAtEpochMs: harness.nowEpochMs,
            expiresAtEpochMs: harness.nowEpochMs + 60_000
        });
    });

    it('queues a verifiable authority proof without serializing the bearer token', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, 'proof-wire-room', 'Before Wire Proof');
        const input: AuthenticatedGroupMutationEnqueue = {
            type: AppInboxType.GROUP_UPDATE,
            resourceId: 'proof-wire-update',
            contextId: 'ar-eye-hunter:default:proof-wire-room',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId: 'proof-wire-room',
                request: {
                    displayName: 'After Wire Proof',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'proof-wire-update'
                }
            }
        };
        const pending = harness.service.processAuthenticatedGroupEntryUntilCompletion(
            input,
            harness.sessions.owner
        );
        await waitForQueueEntry(harness.queue);
        const queuedWire = JSON.stringify(await harness.queueEntries());
        expect(queuedWire).not.toContain(harness.sessions.owner.accessToken);
        expect(queuedWire).toContain('authority');
        expect(queuedWire).toContain('commandMac');

        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        expect(requireGroupStateResult(await pending).status).toBe('ok');
    });
});
