import type { ClientStateWritten } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createTestClientStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { expect, it } from 'vitest';

import { ClientMutationIdempotencyConflictError } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { CLIENT_MUTATION_SERVICE_SCOPE, toClientPrincipalRef } from './client-state-service-test-fixtures.ts';
import type { ClientStatePhaseTestDriver } from './client-state-test-driver-contracts.ts';
import { createClientStateTestDriver, getClientStateTestOutbox } from './client-state-test-runtime.ts';

it('advances authorised websocket generations with complete receipt delivery and makes an old close stale', async () => {
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

    const repository = createTestClientStateRepository(scenario.runtimeRepository);
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
        scenario.service.registerAuthorisedWsClientSession(scenario.authSession, 'generation-b', {
            applicationId: CLIENT_MUTATION_SERVICE_SCOPE.applicationId,
            workspaceId: CLIENT_MUTATION_SERVICE_SCOPE.workspaceId,
            displayName: 'Different Canonical Display',
            connectedAtEpochMs: 200,
            expiresAtEpochMs: scenario.expiresAtEpochMs
        })
    ).rejects.toBeInstanceOf(ClientMutationIdempotencyConflictError);
    const authorisedCommandId = 'authorised-ws:connect:ws-session-ordered:generation-b';
    const authorisedOutbox = getClientStateTestOutbox(scenario.runtimeRepository).filter((entry) => entry.resource.includes(authorisedCommandId));
    const authorisedReceipt = await createTestClientStateRepository(
        scenario.runtimeRepository
    ).findIdempotentClientMutationReceipt(toClientPrincipalRef('alice'), authorisedCommandId);
    expect(authorisedReceipt?.receipt.commandHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(authorisedOutbox.map((entry) => entry.key.resourceId)).toEqual(
        authorisedReceipt?.receipt.outboxIds
    );

    await expectRestGenerationOrdering(scenario);
});

interface GenerationAdvanceScenario {
    readonly authSession: AuthSession;
    readonly first: ClientStateWritten;
    readonly runtimeRepository: FakeRuntimeStateRepository;
    readonly second: ClientStateWritten;
    readonly staleClose: ClientStateWritten;
    readonly third: ClientStateWritten;
}

async function runGenerationAdvanceScenario(): Promise<GenerationAdvanceScenario> {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const service = createClientStateTestDriver({
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
    const expiresAtEpochMs = Date.now() + 60_000;
    const first = await service.registerAuthorisedWsClientSession(authSession, 'ws-generation-1', {
        ...CLIENT_MUTATION_SERVICE_SCOPE,
        connectedAtEpochMs: 100,
        expiresAtEpochMs
    });
    await service.disconnectAuthorisedWsClientSession(authSession.sessionId, 'ws-generation-1', 'first-close');
    const second = await service.registerAuthorisedWsClientSession(authSession, 'ws-generation-2', {
        ...CLIENT_MUTATION_SERVICE_SCOPE,
        connectedAtEpochMs: 200,
        expiresAtEpochMs
    });
    const third = await service.registerAuthorisedWsClientSession(authSession, 'ws-generation-3', {
        ...CLIENT_MUTATION_SERVICE_SCOPE,
        connectedAtEpochMs: 300,
        expiresAtEpochMs
    });
    const staleClose = await service.disconnectAuthorisedWsClientSession(
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
    expect(outbox).toHaveLength(11);
    for (const commandId of commandIds) {
        const receipt = await repository.findIdempotentClientMutationReceipt(
            toClientPrincipalRef('alice'),
            commandId
        );
        const commandEntries = outbox.filter((entry) => receipt?.receipt.outboxIds.includes(entry.key.resourceId));
        const messages = commandEntries.map((entry) => decodePersistedALMessage(entry.resource));
        expect(messages.filter((message) => message.route.topicId === 'client-state.event')).toHaveLength(1);
        expect(messages.filter((message) => message.route.topicId === 'client-state.snapshot'))
            .toHaveLength(commandId.includes(':connect:') ? 2 : 1);
        expect(messages.filter((message) => message.targets?.mode === 'unicast').map((message) => message.targets))
            .toEqual(commandId.includes(':connect:') ? [{ mode: 'unicast', toPeerId: 'ws-session-1' }] : []);
        expect(receipt?.receipt.outboxIds).toEqual(commandEntries.map((entry) => entry.key.resourceId));
    }
}

interface OrderedGenerationScenario {
    readonly authSession: AuthSession;
    readonly delayedOlder: ClientStateWritten;
    readonly entriesAfterNewer: number;
    readonly expiresAtEpochMs: number;
    readonly newer: ClientStateWritten;
    readonly runtimeRepository: FakeRuntimeStateRepository;
    readonly service: ClientStatePhaseTestDriver;
}

async function runOrderedGenerationScenario(): Promise<OrderedGenerationScenario> {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const service = createClientStateTestDriver({
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
    const expiresAtEpochMs = Date.now() + 60_000;
    const newer = await service.registerAuthorisedWsClientSession(authSession, 'generation-b', {
        ...CLIENT_MUTATION_SERVICE_SCOPE,
        displayName: 'Alice Display',
        connectedAtEpochMs: 200,
        expiresAtEpochMs
    });
    const entriesAfterNewer = runtimeRepository.data.size;
    const delayedOlder = await service.registerAuthorisedWsClientSession(authSession, 'generation-a', {
        ...CLIENT_MUTATION_SERVICE_SCOPE,
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
        runtimeRepository,
        service
    };
}

async function expectRestGenerationOrdering(scenario: OrderedGenerationScenario): Promise<void> {
    await scenario.service.connectSession(CLIENT_MUTATION_SERVICE_SCOPE, 'alice', 'alice-rest', 'rest-session', {
        generationId: 'rest-current',
        connectedAtEpochMs: 300,
        expiresAtEpochMs: scenario.expiresAtEpochMs,
        requestId: 'rest-current-connect'
    });
    const entriesAfterRestCurrent = scenario.runtimeRepository.data.size;
    const missingOrderedFact = await scenario.service.connectSession(
        CLIENT_MUTATION_SERVICE_SCOPE,
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
