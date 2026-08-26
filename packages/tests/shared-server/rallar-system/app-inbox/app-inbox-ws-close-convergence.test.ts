import { describe, expect, it } from 'vitest';

import type { StateScope } from '@shared/api/state-types.ts';

import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';

import type {
    AuthenticatedGroupMutationEnqueue,
    GroupCreateAppInboxPayload,
    GroupPresenceConnectAppInboxPayload
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { requireGroupStateWritten } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result-codec.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';

import { toAuthorisedWsClientConnectEnqueue } from '@shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts';

import { type GroupStateWritten } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import {
    delayEntry,
    groupPresenceFacts,
    processNext,
    queuedTypes,
    releaseEntry,
    requireQueuedType,
    waitForQueuedType
} from './test-support/app-inbox-queue-entry-test-helpers.ts';
import {
    createAppInboxWsCloseHarness as createHarness,
    createAuthorisedWsCloseFacts as closeFacts,
    pauseNextLifecycleRead,
    type AuthorisedWsCloseFacts
} from './test-support/app-inbox-ws-close-test-harness.ts';

const SCOPE: StateScope = {
    applicationId: 'ar-eye-hunter',
    workspaceId: 'default'
};
describe('AppInbox websocket close convergence', () => {
    it('rolls back a client connect when close commits after its lifecycle read', async () => {
        let rollbacks = 0;
        const authoritativeWrites: string[] = [];
        const harness = await createHarness({
            onRollback: () => (rollbacks += 1),
            onConditionalWrite: (_operation, namespace) => authoritativeWrites.push(namespace)
        });
        const facts = closeFacts(harness.authSession, 'client-interleaved-close', 5);
        const pause = pauseNextLifecycleRead(harness.clientState);

        const connectEntry = await harness.client.enqueueAuthorisedWsClientConnect({
            authSession: facts.authSession,
            generationId: facts.generationId,
            input: facts.input
        });
        const staleConnect = processNext(harness.reader);
        await pause.reached;
        await enqueueClientClose(harness.client, facts);
        await processNext(harness.secondReader);
        authoritativeWrites.length = 0;
        pause.resume();
        await staleConnect;

        expect(authoritativeWrites[0]).toBe('ws-session-close-high-water');
        expect(rollbacks).toBe(1);
        expect(
            (
                await harness.clients.readSnapshot({
                    ...SCOPE,
                    principalId: harness.authSession.clientId
                })
            )?.activeSessions ?? []
        ).toEqual([]);

        await releaseEntry(harness.queue, connectEntry);
        await processNext(harness.reader);
        expect(
            (
                await harness.clients.readSnapshot({
                    ...SCOPE,
                    principalId: harness.authSession.clientId
                })
            )?.activeSessions ?? []
        ).toEqual([]);
    });

    it('rolls back a group connect when cleanup commits after its lifecycle read', async () => {
        let rollbacks = 0;
        const authoritativeWrites: string[] = [];
        const harness = await createHarness({
            onRollback: () => (rollbacks += 1),
            onConditionalWrite: (_operation, namespace) => authoritativeWrites.push(namespace)
        });
        await createRoom(harness, 'interleaved-cleanup-room');
        rollbacks = 0;
        const facts = closeFacts(harness.authSession, 'group-interleaved-cleanup', 6);
        const presence = groupPresenceFacts(facts, 'interleaved-presence', -50);
        const pause = pauseNextLifecycleRead(harness.groupState);

        const pending = enqueueGroupConnect({
            harness,
            groupId: 'interleaved-cleanup-room',
            facts,
            presence
        });
        const connectEntry = await waitForQueuedType(
            harness.queue,
            AppInboxType.GROUP_PRESENCE_CONNECT
        );
        const staleConnect = processNext(harness.reader);
        await pause.reached;
        await enqueueGroupClose(harness.group, facts);
        await processNext(harness.secondReader);
        authoritativeWrites.length = 0;
        pause.resume();
        await staleConnect;

        expect(authoritativeWrites[0]).toBe('ws-session-close-high-water');
        expect(rollbacks).toBe(1);
        expect(await activeGroupSessionCount(harness, 'interleaved-cleanup-room')).toBe(0);

        await releaseEntry(harness.queue, connectEntry);
        await processNext(harness.reader);
        const result = await pending;
        expect(result.left).toBeUndefined();
        expect(result.right).toBeDefined();
        expect(await activeGroupSessionCount(harness, 'interleaved-cleanup-room')).toBe(0);
    });

    it('processes connect then disconnect to an inactive client session', async () => {
        const harness = await createHarness();
        const facts = closeFacts(harness.authSession, 'client-connect-first', 10);

        await harness.client.enqueueAuthorisedWsClientConnect({
            authSession: facts.authSession,
            generationId: facts.generationId,
            input: facts.input
        });
        await processNext(harness.reader);
        await enqueueClientClose(harness.client, facts);
        await processNext(harness.reader);

        const snapshot = await harness.clients.readSnapshot({
            ...SCOPE,
            principalId: harness.authSession.clientId
        });
        expect(snapshot?.isOnline).toBe(false);
        expect(snapshot?.activeSessions).toEqual([]);
    });

    it('processes disconnect before delayed connect without an orphan active client', async () => {
        const harness = await createHarness();
        const facts = closeFacts(harness.authSession, 'client-disconnect-first', 20);

        await harness.client.enqueueAuthorisedWsClientConnect({
            authSession: facts.authSession,
            generationId: facts.generationId,
            input: facts.input
        });
        const connect = await requireQueuedType(
            harness.queue,
            AppInboxType.CLIENT_AUTHORISED_WS_CONNECT
        );
        await delayEntry(harness.queue, connect);
        await enqueueClientClose(harness.client, facts);
        await processNext(harness.reader);
        await releaseEntry(harness.queue, connect);
        await processNext(harness.reader);

        const snapshot = await harness.clients.readSnapshot({
            ...SCOPE,
            principalId: harness.authSession.clientId
        });
        expect(snapshot?.isOnline ?? false).toBe(false);
        expect(snapshot?.activeSessions ?? []).toEqual([]);
        expect(await queuedTypes(harness.queue)).toContain(
            AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT
        );
    });

    it('always enqueues one group cleanup fact and converges connect then cleanup', async () => {
        const harness = await createHarness();
        await createRoom(harness, 'connect-first-room');
        const facts = closeFacts(harness.authSession, 'group-connect-first', 30);
        const presence = groupPresenceFacts(facts, 'presence-connect-first', -50);

        const pending = enqueueGroupConnect({
            harness,
            groupId: 'connect-first-room',
            facts,
            presence
        });
        await waitForQueuedType(harness.queue, AppInboxType.GROUP_PRESENCE_CONNECT);
        await processNext(harness.reader);
        expect((await pending).right).toBeDefined();
        expect(await activeGroupSessionCount(harness, 'connect-first-room')).toBe(1);
        const cleanupCount = await enqueueGroupClose(harness.group, facts);
        expect(cleanupCount).toBe(1);
        await processNext(harness.reader);

        expect(await activeGroupSessionCount(harness, 'connect-first-room')).toBe(0);
    });

    it(
        'processes group cleanup before delayed presence connect ' + 'without orphan presence',
        async () => {
            const harness = await createHarness();
            await createRoom(harness, 'cleanup-first-room');
            const facts = closeFacts(harness.authSession, 'group-cleanup-first', 40);
            const presence = groupPresenceFacts(facts, 'presence-cleanup-first', -50);

            const pending = enqueueGroupConnect({
                harness,
                groupId: 'cleanup-first-room',
                facts,
                presence
            });
            const connect = await waitForQueuedType(harness.queue, AppInboxType.GROUP_PRESENCE_CONNECT);
            await delayEntry(harness.queue, connect);
            const cleanupCount = await enqueueGroupClose(harness.group, facts);
            expect(cleanupCount).toBe(1);
            await processNext(harness.reader);
            await releaseEntry(harness.queue, connect);
            await processNext(harness.reader);
            await pending;

            expect(await activeGroupSessionCount(harness, 'cleanup-first-room')).toBe(0);
            expect(await queuedTypes(harness.queue)).toContain(
                AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP
            );
        }
    );

    it(
        'suppresses an older delayed client generation ' + 'after a newer generation closes first',
        async () => {
            const harness = await createHarness();
            const older = closeFacts(harness.authSession, 'client-generation-a', 50);
            const newer = closeFacts(harness.authSession, 'client-generation-b', 60);
            const olderConnect = await harness.client.enqueueAuthorisedWsClientConnect({
                authSession: older.authSession,
                generationId: older.generationId,
                input: older.input
            });
            const newerConnect = await harness.client.enqueueAuthorisedWsClientConnect({
                authSession: newer.authSession,
                generationId: newer.generationId,
                input: newer.input
            });
            await delayEntry(harness.queue, olderConnect);
            await delayEntry(harness.queue, newerConnect);

            await enqueueClientClose(harness.client, newer);
            await processNext(harness.reader);
            await releaseEntry(harness.queue, olderConnect);
            await processNext(harness.reader);
            await releaseEntry(harness.queue, newerConnect);
            await processNext(harness.reader);

            const snapshot = await harness.clients.readSnapshot({
                ...SCOPE,
                principalId: harness.authSession.clientId
            });
            expect(snapshot?.activeSessions ?? []).toEqual([]);
        }
    );

    it('does not let an older close disconnect a newer active client generation', async () => {
        const harness = await createHarness();
        const older = closeFacts(harness.authSession, 'client-generation-a', 70);
        const newer = closeFacts(harness.authSession, 'client-generation-b', 80);

        await harness.client.enqueueAuthorisedWsClientConnect({
            authSession: newer.authSession,
            generationId: newer.generationId,
            input: newer.input
        });
        await processNext(harness.reader);
        await enqueueClientClose(harness.client, older);
        await processNext(harness.reader);

        const snapshot = await harness.clients.readSnapshot({
            ...SCOPE,
            principalId: harness.authSession.clientId
        });
        expect(snapshot?.activeSessions.map((session) => session.generationId)).toEqual([
            newer.generationId
        ]);
    });
});
async function enqueueClientClose(
    service: AppClientInboxService,
    facts: AuthorisedWsCloseFacts
): Promise<void> {
    await service.enqueueAuthorisedWsClientDisconnect({
        connection: toAuthorisedWsClientConnectEnqueue({
            authSession: facts.authSession,
            generationId: facts.generationId,
            input: facts.input
        }).data,
        disconnectedAtEpochMs: facts.disconnectedAtEpochMs,
        reason: facts.reason
    });
}

async function enqueueGroupClose(
    service: GroupStateInboxService,
    facts: AuthorisedWsCloseFacts
): Promise<number> {
    return await service.enqueueGroupSessionCleanup({
        connection: toAuthorisedWsClientConnectEnqueue({
            authSession: facts.authSession,
            generationId: facts.generationId,
            input: facts.input
        }).data,
        disconnectedAtEpochMs: facts.disconnectedAtEpochMs,
        reason: facts.reason
    });
}

async function createRoom(
    harness: Awaited<ReturnType<typeof createHarness>>,
    groupId: string
): Promise<void> {
    const pending = processAuthenticated(harness.group, harness.authSession, {
        type: AppInboxType.GROUP_CREATE,
        resourceId: `create-${groupId}`,
        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
        senderId: harness.authSession.clientId,
        data: {
            scope: SCOPE,
            request: {
                groupId,
                displayName: groupId,
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: harness.authSession.clientId,
                actorPrincipalId: harness.authSession.clientId,
                actorSessionId: harness.authSession.sessionId,
                requestId: `create-${groupId}`
            }
        }
    });
    await waitForQueuedType(harness.queue, AppInboxType.GROUP_CREATE);
    await processNext(harness.reader);
    const result = await pending;
    if (!result.right) {
        throw new Error('Expected group creation result');
    }
    expect(requireGroupStateWritten(result.right).status).toBe('created');
}

interface EnqueueGroupConnectInput {
    readonly harness: Awaited<ReturnType<typeof createHarness>>;
    readonly groupId: string;
    readonly facts: AuthorisedWsCloseFacts;
    readonly presence?: Readonly<{
        generationId: string;
        connectedAtEpochMs: number;
        expiresAtEpochMs: number;
    }>;
}

function enqueueGroupConnect(input: EnqueueGroupConnectInput) {
    const { harness, groupId, facts } = input;
    const presence = input.presence ?? groupPresenceFacts(facts, facts.generationId, 0);
    return processAuthenticated(harness.group, harness.authSession, {
        type: AppInboxType.GROUP_PRESENCE_CONNECT,
        resourceId: `presence-${groupId}-${presence.generationId}`,
        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
        senderId: harness.authSession.clientId,
        data: {
            scope: SCOPE,
            groupId,
            sessionId: facts.authSession.sessionId,
            request: {
                principalId: facts.authSession.clientId,
                generationId: presence.generationId,
                connectedAtEpochMs: presence.connectedAtEpochMs,
                lastHeartbeatAtEpochMs: presence.connectedAtEpochMs,
                expiresAtEpochMs: presence.expiresAtEpochMs,
                actorPrincipalId: facts.authSession.clientId,
                actorSessionId: facts.authSession.sessionId,
                requestId: `presence-${groupId}-${presence.generationId}`
            }
        }
    });
}

function processAuthenticated(
    service: GroupStateInboxService,
    authority: IssuedAuthSession,
    enqueue: AuthenticatedGroupMutationEnqueue
): ReturnType<GroupStateInboxService['processAuthenticatedGroupEntryUntilCompletion']> {
    return service.processAuthenticatedGroupEntryUntilCompletion(enqueue, authority);
}

async function activeGroupSessionCount(
    harness: Awaited<ReturnType<typeof createHarness>>,
    groupId: string
): Promise<number> {
    return (await harness.groups.listAllPresenceSessions()).filter(
        (session) => session.groupId === groupId && session.disconnectedAtEpochMs === null
    ).length;
}
