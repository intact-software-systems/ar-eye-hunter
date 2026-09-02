import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { toAuthorisedWsClientConnection } from '@shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts';
import type { WsSessionGenerationLifecycleComputed } from '@shared-server/rallar-system/websocket/ws-session-generation-computation.ts';
import * as lifecycleComputation from '@shared-server/rallar-system/websocket/ws-session-generation-computation.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import { processNext, requireQueuedType, waitForQueuedType } from './test-support/app-inbox-queue-entry-test-helpers.ts';
import { createAppInboxWsCloseHarness, createAuthorisedWsCloseFacts } from './test-support/app-inbox-ws-close-test-harness.ts';

type LifecyclePersistenceField = 'value' | 'expireAtIsoTimestamp';

describe('AppInbox validates exact WebSocket lifecycle persistence', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each(['value', 'expireAtIsoTimestamp'] as const)(
        'rejects a tampered client-connect %s before authoritative writes',
        async (field) => {
            const writes: string[] = [];
            const harness = await createAppInboxWsCloseHarness({
                onConditionalWrite: (_operation, namespace) => writes.push(namespace)
            });
            const facts = createAuthorisedWsCloseFacts(harness.authSession, 'client-connect-validation', 1);
            const issuePaths = tamperConnect(field);

            await harness.client.enqueueAuthorisedWsClientConnect(facts);
            await processNext(harness.reader);

            expect(writes).toEqual([]);
            expect(issuePaths).toContain(`computed.${field}`);
            expect((await requireQueuedType(harness.queue, AppInboxType.CLIENT_AUTHORISED_WS_CONNECT)).status).toBe(
                EntityStatus.FAILED
            );
        }
    );

    it.each(['value', 'expireAtIsoTimestamp'] as const)(
        'rejects a tampered missing-client disconnect %s before authoritative writes',
        async (field) => {
            const writes: string[] = [];
            const harness = await createAppInboxWsCloseHarness({
                onConditionalWrite: (_operation, namespace) => writes.push(namespace)
            });
            const facts = createAuthorisedWsCloseFacts(harness.authSession, 'client-close-validation', 2);
            const issuePaths = tamperClose(field);

            await harness.client.enqueueAuthorisedWsClientDisconnect({
                connection: toAuthorisedWsClientConnection(facts),
                disconnectedAtEpochMs: facts.disconnectedAtEpochMs,
                reason: facts.reason
            });
            await processNext(harness.reader);

            expect(writes).toEqual([]);
            expect(issuePaths).toContain(`computed.${field}`);
            expect((await requireQueuedType(harness.queue, AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT)).status).toBe(
                EntityStatus.FAILED
            );
        }
    );

    it.each(['value', 'expireAtIsoTimestamp'] as const)(
        'rejects a tampered group cleanup %s even with no active groups',
        async (field) => {
            const writes: string[] = [];
            const harness = await createAppInboxWsCloseHarness({
                onConditionalWrite: (_operation, namespace) => writes.push(namespace)
            });
            const facts = createAuthorisedWsCloseFacts(harness.authSession, 'group-close-validation', 3);
            const issuePaths = tamperClose(field);

            await harness.group.enqueueGroupSessionCleanup({
                connection: toAuthorisedWsClientConnection(facts),
                disconnectedAtEpochMs: facts.disconnectedAtEpochMs,
                reason: facts.reason
            });
            await processNext(harness.reader);

            expect(writes).toEqual([]);
            expect(issuePaths).toContain(`computed.${field}`);
            expect((await requireQueuedType(harness.queue, AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP)).status).toBe(
                EntityStatus.FAILED
            );
        }
    );

    it.each(['value', 'expireAtIsoTimestamp'] as const)(
        'rejects a tampered group-connect %s before presence or lifecycle writes',
        async (field) => {
            const writes: string[] = [];
            const harness = await createAppInboxWsCloseHarness({
                onConditionalWrite: (_operation, namespace) => writes.push(namespace)
            });
            await createGroup(harness);
            writes.length = 0;
            const facts = createAuthorisedWsCloseFacts(harness.authSession, 'group-connect-validation', 4);
            const issuePaths = tamperConnect(field);
            const pending = harness.group.processAuthenticatedGroupEntryUntilCompletion({
                type: AppInboxType.GROUP_PRESENCE_CONNECT,
                resourceId: 'presence-validation',
                contextId: 'ar-eye-hunter:default:lifecycle-validation',
                senderId: harness.authSession.clientId,
                data: {
                    scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' },
                    groupId: 'lifecycle-validation',
                    sessionId: harness.authSession.sessionId,
                    request: {
                        principalId: harness.authSession.clientId,
                        generationId: facts.generationId,
                        connectedAtEpochMs: facts.input.connectedAtEpochMs,
                        lastHeartbeatAtEpochMs: facts.input.connectedAtEpochMs,
                        expiresAtEpochMs: facts.input.expiresAtEpochMs,
                        actorPrincipalId: harness.authSession.clientId,
                        actorSessionId: harness.authSession.sessionId,
                        requestId: 'presence-validation'
                    }
                }
            }, harness.authSession);
            await waitForQueuedType(harness.queue, AppInboxType.GROUP_PRESENCE_CONNECT);
            await processNext(harness.reader);
            const result = await pending;

            expect(writes).toEqual([]);
            expect(issuePaths).toContain(`computed.${field}`);
            expect(result.right).toBeUndefined();
            expect(result.left).toBeDefined();
            expect(await harness.groups.listAllPresenceSessions()).toEqual([]);
        }
    );
});

function tamperConnect(field: LifecyclePersistenceField): readonly string[] {
    const issuePaths: string[] = [];
    const compute = lifecycleComputation.computeWsSessionConnectGuard;
    const validate = lifecycleComputation.validateWsSessionConnectGuard;
    vi.spyOn(lifecycleComputation, 'computeWsSessionConnectGuard').mockImplementation((facts, read) => toTamperedPersistence(compute(facts, read), field));
    vi.spyOn(lifecycleComputation, 'validateWsSessionConnectGuard').mockImplementation((facts, read, computed) => {
        const issues = validate(facts, read, computed);
        issuePaths.push(...issues.map((issue) => issue.path));
        return issues;
    });
    return issuePaths;
}

function tamperClose(field: LifecyclePersistenceField): readonly string[] {
    const issuePaths: string[] = [];
    const compute = lifecycleComputation.computeWsSessionGenerationClosed;
    const validate = lifecycleComputation.validateWsSessionGenerationClosed;
    vi.spyOn(lifecycleComputation, 'computeWsSessionGenerationClosed').mockImplementation((facts, read) => toTamperedPersistence(compute(facts, read), field));
    vi.spyOn(lifecycleComputation, 'validateWsSessionGenerationClosed').mockImplementation((facts, read, computed) => {
        const issues = validate(facts, read, computed);
        issuePaths.push(...issues.map((issue) => issue.path));
        return issues;
    });
    return issuePaths;
}

function toTamperedPersistence(
    computed: WsSessionGenerationLifecycleComputed,
    field: LifecyclePersistenceField
): WsSessionGenerationLifecycleComputed {
    return field === 'value'
        ? { ...computed, value: '{"wrong":"lifecycle"}' }
        : { ...computed, expireAtIsoTimestamp: '9999-12-31T23:59:59.999Z' };
}

async function createGroup(harness: Awaited<ReturnType<typeof createAppInboxWsCloseHarness>>): Promise<void> {
    const pending = harness.group.processAuthenticatedGroupEntryUntilCompletion({
        type: AppInboxType.GROUP_CREATE,
        resourceId: 'create-lifecycle-validation',
        contextId: 'ar-eye-hunter:default:lifecycle-validation',
        senderId: harness.authSession.clientId,
        data: {
            scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' },
            request: {
                groupId: 'lifecycle-validation',
                displayName: 'Lifecycle validation',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: harness.authSession.clientId,
                actorPrincipalId: harness.authSession.clientId,
                actorSessionId: harness.authSession.sessionId,
                requestId: 'create-lifecycle-validation'
            }
        }
    }, harness.authSession);
    await waitForQueuedType(harness.queue, AppInboxType.GROUP_CREATE);
    await processNext(harness.reader);
    expect((await pending).right).toBeDefined();
}
