import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { describe, expect, it, vi } from 'vitest';
import { createAppInboxTestDatabase, type AppInboxTestDatabase } from '../../rallar-system/app-inbox/test-support/app-inbox-test-database.ts';

import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';

import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { type GroupStateWritten } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import {
    type AuthenticatedGroupMutationEnqueue,
    type GroupCreateAppInboxPayload,
    type GroupMemberUpsertAppInboxPayload,
    type GroupPresenceConnectAppInboxPayload,
    type GroupPresenceHeartbeatAppInboxPayload,
    type GroupUpdateAppInboxPayload
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-group-state-event-store.ts';

import { type GroupMutationReceipt } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
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

describe('GroupStateInboxService authenticated authority', () => {
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

    it('exposes no unauthenticated queue-processing entry point', async () => {
        const harness = await createAuthorityHarness(['owner']);
        expect(Reflect.get(harness.service, 'processEntryUntilCompletion')).toBeUndefined();
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

        expect((await pending).left?.message).toContain(
            'authenticated group mutation intent is malformed'
        );
        expect(
            await harness.repository.readSnapshot({
                ...SCOPE,
                groupId: 'raw-extra-proof'
            })
        ).toBeUndefined();
    });

    it('rejects a dequeued user command whose authority descriptor has predecessor fields', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const input: AuthenticatedGroupMutationEnqueue = {
            type: AppInboxType.GROUP_CREATE,
            resourceId: 'raw-extra-descriptor-request',
            contextId: 'ar-eye-hunter:default:raw-extra-descriptor-request',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                request: {
                    groupId: 'raw-extra-descriptor-request',
                    displayName: 'Must Not Exist',
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: 'owner',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'raw-extra-descriptor-request'
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
            authority: { descriptor: { request: Record<string, JsonWireValue>; }; };
        };
        command.authority.descriptor.request.predecessorActorId = 'owner';
        message.payload.resource = JSON.stringify(command);
        await harness.queue.enqueue({
            ...entry,
            resource: JSON.stringify(message)
        });
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        expect((await pending).left?.message).toContain(
            'authenticated group mutation intent is malformed'
        );
        expect(
            await harness.repository.readSnapshot({
                ...SCOPE,
                groupId: 'raw-extra-descriptor-request'
            })
        ).toBeUndefined();
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
                serviceId: 'server-12345678',
                now: () => nowEpochMs,
                groupStateEventStore: new InMemoryGroupStateEventStore(),
                authSessionRepository: authSessions
            } as
                & Parameters<typeof createGroupStateService>[0]
                & Readonly<{
                    authSessionRepository: AuthSessionRepository;
                }>
        );
        const service = new GroupStateInboxService(
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
        const repository = createTestGroupStateRepository(runtimeRepository);
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
