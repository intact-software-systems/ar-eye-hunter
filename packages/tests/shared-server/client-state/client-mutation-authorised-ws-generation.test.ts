import { describe, expect, it } from 'vitest';

import { ClientMutationIdempotencyConflictError } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import { CLIENT_MUTATION_SERVICE_SCOPE as SCOPE, toClientPrincipalRef } from './client-state-service-test-fixtures.ts';
import { createClientStateTestDriver as createClientStateService, getClientStateTestOutbox } from './client-state-test-runtime.ts';

describe('client mutation authorised WebSocket generation', () => {
    it('advances authorised websocket generations and makes an old close stale', async () => {
        const scenario = await runGenerationAdvanceScenario();

        expect(scenario.second).toMatchObject({
            status: 'ok',
            result: {
                snapshot: {
                    principal: {
                        principalId: 'alice',
                        snapshotVersion: 3
                    }
                }
            }
        });
        expect(scenario.first.result?.event?.eventType).toBe('session-connected');
        expect(scenario.second.result?.event?.eventType).toBe('session-connected');
        expect(scenario.third.result?.event?.eventType).toBe('session-connected');
        expect(scenario.staleClose.result?.snapshot.activeSessions).toEqual([
            expect.objectContaining({
                sessionId: scenario.authSession.sessionId,
                generationId: 'ws-generation-3',
                generationVersion: 3,
                status: 'active'
            })
        ]);

        const repository = new ClientStateRepository(scenario.runtimeRepository);
        expect(
            await repository.findSession({
                ...toClientPrincipalRef('alice'),
                clientInstanceId: 'alice',
                sessionId: scenario.authSession.sessionId
            })
        ).toMatchObject({
            generationId: 'ws-generation-3',
            generationVersion: 3,
            status: 'active'
        });
        expect(
            (await repository.listEvents(toClientPrincipalRef('alice'))).map((event) => event.eventType)
        ).toEqual([
            'session-connected',
            'session-disconnected',
            'session-connected',
            'session-connected'
        ]);
        await expectGenerationReceiptOutbox(scenario.runtimeRepository, repository);
    });

    it('orders websocket generations by their server-owned start tuple and bootstraps the authorised principal', async () => {
        const scenario = await runOrderedGenerationScenario();

        expect(scenario.newer.result?.snapshot).toMatchObject({
            principal: {
                username: 'alice-login',
                displayName: 'Alice Display',
                roles: ['member']
            },
            activeSessions: [
                {
                    generationId: 'generation-b',
                    connectedAtEpochMs: 200
                }
            ]
        });
        expect(scenario.delayedOlder.result?.event).toBeNull();
        expect(scenario.delayedOlder.result?.snapshot.activeSessions).toEqual([
            expect.objectContaining({
                generationId: 'generation-b',
                connectedAtEpochMs: 200
            })
        ]);
        expect(scenario.runtimeRepository.data.size).toBe(scenario.entriesAfterNewer);
        await expect(
            scenario.register(scenario.authSession, 'generation-b', {
                applicationId: SCOPE.applicationId,
                workspaceId: SCOPE.workspaceId,
                displayName: 'Different Canonical Display',
                connectedAtEpochMs: 200,
                expiresAtEpochMs: scenario.expiresAtEpochMs
            })
        ).rejects.toBeInstanceOf(ClientMutationIdempotencyConflictError);
        const authorisedCommandId = 'authorised-ws:connect:ws-session-ordered:generation-b';
        const authorisedOutbox = getClientStateTestOutbox(scenario.runtimeRepository).filter((entry) => entry.resource.includes(authorisedCommandId));
        const authorisedReceipt = await new ClientStateRepository(
            scenario.runtimeRepository
        ).findIdempotentClientMutationReceipt(toClientPrincipalRef('alice'), authorisedCommandId);
        expect(authorisedReceipt?.receipt.commandHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
        expect(authorisedOutbox.map((entry) => entry.key.resourceId)).toEqual(
            authorisedReceipt?.receipt.outboxIds
        );

        await expectRestGenerationOrdering(scenario);
    });
});

async function runGenerationAdvanceScenario() {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const service = createClientStateService({
        runtimeRepository,
        now: () => 5_000,
        serviceId: 'client-service'
    });
    const authSession: AuthSession = {
        clientId: 'alice',
        username: 'alice',
        accessToken: 'token',
        sessionId: 'ws-session-1',
        expiresAtEpochMs: 60_000
    };
    const register = service.registerAuthorisedWsClientSession.bind(service);
    const disconnect = service.disconnectAuthorisedWsClientSession.bind(service);
    const expiresAtEpochMs = Date.now() + 60_000;
    const first = await register(authSession, 'ws-generation-1', {
        ...SCOPE,
        connectedAtEpochMs: 100,
        expiresAtEpochMs
    });
    await disconnect(authSession.sessionId, 'ws-generation-1', 'first-close');
    const second = await register(authSession, 'ws-generation-2', {
        ...SCOPE,
        connectedAtEpochMs: 200,
        expiresAtEpochMs
    });
    const third = await register(authSession, 'ws-generation-3', {
        ...SCOPE,
        connectedAtEpochMs: 300,
        expiresAtEpochMs
    });
    const staleClose = await disconnect(
        authSession.sessionId,
        'ws-generation-2',
        'delayed-second-close'
    );
    return { authSession, first, runtimeRepository, second, staleClose, third };
}

async function expectGenerationReceiptOutbox(
    runtimeRepository: FakeRuntimeStateRepository,
    repository: ClientStateRepository
): Promise<void> {
    const commandIds = [
        'authorised-ws:connect:ws-session-1:ws-generation-1',
        'authorised-ws:connect:ws-session-1:ws-generation-2',
        'authorised-ws:connect:ws-session-1:ws-generation-3',
        'authorised-ws:disconnect:ws-session-1:ws-generation-1'
    ];
    const outbox = getClientStateTestOutbox(runtimeRepository);
    expect(outbox).toHaveLength(8);
    for (const commandId of commandIds) {
        const receipt = await repository.findIdempotentClientMutationReceipt(
            toClientPrincipalRef('alice'),
            commandId
        );
        const commandEntries = outbox.filter((entry) => receipt?.receipt.outboxIds.includes(entry.key.resourceId));
        expect(commandEntries).toHaveLength(2);
        expect(receipt?.receipt.outboxIds).toEqual(commandEntries.map((entry) => entry.key.resourceId));
    }
}

async function runOrderedGenerationScenario() {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const service = createClientStateService({
        runtimeRepository,
        now: () => 10_000,
        serviceId: 'client-service'
    });
    const authSession: AuthSession = {
        clientId: 'alice',
        username: 'alice-login',
        accessToken: 'token',
        sessionId: 'ws-session-ordered',
        expiresAtEpochMs: 60_000
    };
    const register = service.registerAuthorisedWsClientSession.bind(service);
    const expiresAtEpochMs = Date.now() + 60_000;
    const newer = await register(authSession, 'generation-b', {
        ...SCOPE,
        displayName: 'Alice Display',
        connectedAtEpochMs: 200,
        expiresAtEpochMs
    });
    const entriesAfterNewer = runtimeRepository.data.size;
    const delayedOlder = await register(authSession, 'generation-a', {
        ...SCOPE,
        displayName: 'Ignored Old Display',
        connectedAtEpochMs: 100,
        expiresAtEpochMs
    });
    return {
        authSession,
        delayedOlder,
        entriesAfterNewer,
        expiresAtEpochMs,
        newer,
        register,
        runtimeRepository,
        service
    };
}

type OrderedGenerationScenario = Awaited<ReturnType<typeof runOrderedGenerationScenario>>;

async function expectRestGenerationOrdering(scenario: OrderedGenerationScenario): Promise<void> {
    await scenario.service.connectSession(SCOPE, 'alice', 'alice-rest', 'rest-session', {
        generationId: 'rest-current',
        connectedAtEpochMs: 300,
        expiresAtEpochMs: scenario.expiresAtEpochMs,
        requestId: 'rest-current-connect'
    });
    const entriesAfterRestCurrent = scenario.runtimeRepository.data.size;
    const missingOrderedFact = await scenario.service.connectSession(
        SCOPE,
        'alice',
        'alice-rest',
        'rest-session',
        {
            generationId: 'rest-arbitrary-old-token',
            expiresAtEpochMs: scenario.expiresAtEpochMs,
            requestId: 'rest-missing-ordered-fact'
        }
    );
    expect(missingOrderedFact.result?.event).toBeNull();
    expect(missingOrderedFact.result?.snapshot.activeSessions).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ sessionId: 'rest-session', generationId: 'rest-current' })
        ])
    );
    expect(scenario.runtimeRepository.data.size).toBe(entriesAfterRestCurrent);
}
