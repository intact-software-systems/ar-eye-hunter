import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import type { BlackBoxBrowserDirectorDependency } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts';
import type { BlackBoxRallarDirectorOutputRecord } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/contracts.ts';
import type { RallarDirectorRelayMessage, RallarDirectorStatus } from '@shared-web/browser/director/rallar-director-facade.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { facade, loadRuntime, resetFacade, topics } from './browser-rallar-runtime-test-harness.ts';

const roomRef: GroupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-a',
    groupId: 'room-1'
};

const directorStatus: RallarDirectorStatus = {
    roomRef,
    roomId: 'room-1',
    role: 'director',
    state: 'fresh',
    isDirector: true,
    isFresh: true,
    active: true,
    freshness: 'fresh',
    nowEpochMs: 1_000,
    appointment: {
        version: 1,
        mode: 'appointed-spa',
        sessionId: 'session-1',
        principalId: 'client-1',
        epoch: 1,
        appointedAtEpochMs: 1_000,
        heartbeatTtlMs: 1_200
    }
};

interface DirectorRelayScenario {
    readonly relay: ReturnType<BlackBoxBrowserDirectorDependency['createRelay']>;
    config(): Parameters<BlackBoxBrowserDirectorDependency['createRelay']>[0];
}

beforeEach(() => {
    resetFacade();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('appoints a director and exposes its refreshed room status', async () => {
    const scenario = configureDirectorRelayScenario();
    const runtime = await loadConnectedDirectorRuntime();

    const appoint = await runtime.director.appoint({
        roomId: 'room-1',
        roomRef,
        heartbeatTtlMs: 1_200
    });
    const status = await runtime.director.status({
        roomId: 'room-1',
        roomRef,
        refresh: true
    });
    const start = await startDirectorRelay(runtime);

    expect(facade.records.directorAppointments).toContainEqual([
        roomRef,
        expect.objectContaining({ heartbeatTtlMs: 1_200 })
    ]);
    expect(facade.records.roomRefreshes.length).toBeGreaterThan(0);
    expect(appoint).toMatchObject({ status: 'appointed', role: 'director' });
    expect(status).toMatchObject({ status: 'status', state: 'fresh' });
    expect(start).toMatchObject({ status: 'relay_started', handle: 'relay-1' });
    expect(scenario.config()).toMatchObject({
        roomId: 'room-1',
        roomRef,
        topicId: 'app.test.director',
        intentTypeId: 'app.test.director.intent',
        outputTypeId: 'app.test.director.output',
        heartbeatIntervalMs: 300,
        snapshotIntervalMs: 500
    });
});

it('routes relay input, output, snapshot, and sync messages into its summary', async () => {
    const scenario = configureDirectorRelayScenario();
    const runtime = await loadConnectedDirectorRuntime();
    await startDirectorRelay(runtime);

    const output = await receiveDirectorIntent(scenario);
    await receiveDirectorObservations(scenario, output);
    const stop = await runtime.director.relayStop({ handle: 'relay-1' });

    expect(output).toMatchObject({
        kind: 'black-box-director-output',
        intentId: 'intent-b-1',
        senderId: 'session-b',
        directorSessionId: 'session-1',
        epoch: 1
    });
    expect(stop).toMatchObject({
        status: 'relay_stopped',
        acceptedIntentCount: 1,
        outputCount: 2,
        snapshotCount: 1,
        syncRequestCount: 1
    });
    expect(topics()).toEqual(expect.arrayContaining([
        'rallar.browser.director.intent_received',
        'rallar.browser.director.output_received',
        'rallar.browser.director.snapshot_received',
        'rallar.browser.director.sync_request_received'
    ]));
});

it('sends relay intent and sync requests before releasing the handle', async () => {
    configureDirectorRelayScenario();
    const runtime = await loadConnectedDirectorRuntime();
    await startDirectorRelay(runtime);

    const intent = await runtime.director.intent({
        handle: 'relay-1',
        intent: { intentId: 'intent-c-1' }
    });
    const sync = await runtime.director.syncRequest({
        handle: 'relay-1',
        payload: { reason: 'late-join' }
    });
    const stop = await runtime.director.relayStop({ handle: 'relay-1' });
    const health = await runtime.health();

    expect(intent).toMatchObject({ status: 'intent_sent', sendResult: { status: 'sent' } });
    expect(sync).toMatchObject({ status: 'sync_requested', sendResult: { status: 'sent' } });
    expect(stop).toMatchObject({ status: 'relay_stopped' });
    expect(health).toMatchObject({ director: { handles: [] } });
    expect(topics()).toEqual(expect.arrayContaining([
        'rallar.browser.director.relay_started',
        'rallar.browser.director.intent_sent',
        'rallar.browser.director.sync_requested',
        'rallar.browser.director.relay_stopped'
    ]));
});

function configureDirectorRelayScenario(): DirectorRelayScenario {
    let config: Parameters<BlackBoxBrowserDirectorDependency['createRelay']>[0] | undefined;
    const relay: ReturnType<BlackBoxBrowserDirectorDependency['createRelay']> = {
        status: () => directorStatus,
        sendIntent: async () => ({ status: 'sent' }),
        sendOutput: async () => ({ status: 'sent' }),
        sendHeartbeat: async () => ({ status: 'sent' }),
        sendSnapshot: async () => ({ status: 'sent' }),
        requestSync: async () => ({ status: 'sent' }),
        stop: () => undefined
    };
    facade.behavior.directorAppoint.mockResolvedValue(directorStatus);
    facade.behavior.directorResign.mockResolvedValue({
        ...directorStatus,
        role: 'none',
        state: 'none',
        isDirector: false,
        isFresh: false,
        appointment: undefined
    });
    facade.behavior.directorStatus.mockReturnValue(directorStatus);
    facade.behavior.directorCreateRelay.mockImplementation((createdConfig) => {
        config = createdConfig;
        return relay;
    });
    return {
        relay,
        config: () => {
            if (config === undefined) {
                throw new Error('The director relay was not created.');
            }
            return config;
        }
    };
}

async function loadConnectedDirectorRuntime(): Promise<BlackBoxRallarRuntime> {
    const runtime = await loadRuntime();
    await runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        roomRef,
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            roomRef
        }
    });
    return runtime;
}

async function startDirectorRelay(runtime: BlackBoxRallarRuntime) {
    return await runtime.director.relayStart({
        handle: 'relay-1',
        roomId: 'room-1',
        roomRef,
        topicId: 'app.test.director',
        intentTypeId: 'app.test.director.intent',
        outputTypeId: 'app.test.director.output',
        heartbeatIntervalMs: 300,
        snapshotIntervalMs: 500
    });
}

async function receiveDirectorIntent(
    scenario: DirectorRelayScenario
): Promise<BlackBoxRallarDirectorOutputRecord> {
    const output = await scenario.config().onIntent?.(
        relayMessage({ intentId: 'intent-b-1', action: 'move' }, 'session-b', 1_100),
        scenario.relay
    );
    if (!isDirectorOutput(output)) {
        throw new Error('The director relay did not produce a single output record.');
    }
    return output;
}

async function receiveDirectorObservations(
    scenario: DirectorRelayScenario,
    output: BlackBoxRallarDirectorOutputRecord
): Promise<void> {
    const config = scenario.config();
    if (
        config.onOutput === undefined ||
        config.onSnapshot === undefined ||
        config.readSnapshot === undefined ||
        config.onSyncRequest === undefined
    ) {
        throw new Error('The director relay did not register all observation handlers.');
    }
    await config.onOutput(relayMessage(output, 'session-1', 1_150));
    const snapshot = await config.readSnapshot();
    if (snapshot === undefined) {
        throw new Error('The director relay did not produce a snapshot.');
    }
    await config.onSnapshot(relayMessage(snapshot, 'session-1', 1_200));
    await config.onSyncRequest(
        relayMessage({ reason: 'unit-test' }, 'session-b', 1_250),
        scenario.relay
    );
}

function relayMessage<T>(data: T, senderId: string, receivedAtEpochMs: number): RallarDirectorRelayMessage<T> {
    return {
        transport: 'rtc',
        senderId,
        data,
        envelope: {
            protocol: 'rallar.director.relay.v1',
            topicId: 'app.test.director',
            typeId: 'app.test.director.message',
            roomId: 'room-1',
            epoch: 1,
            sentAtEpochMs: receivedAtEpochMs - 1,
            payload: data
        },
        receivedAtEpochMs
    };
}

function isDirectorOutput(
    value: void | RallarMessagePayload | readonly BlackBoxRallarDirectorOutputRecord[]
): value is BlackBoxRallarDirectorOutputRecord {
    return typeof value === 'object' && value !== null && 'kind' in value &&
        value.kind === 'black-box-director-output';
}
