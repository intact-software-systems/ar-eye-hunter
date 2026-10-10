import { afterEach, beforeEach, expect, vi } from 'vitest';

import type { BlackBoxRallarEvent } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import {
    createBlackBoxRallarRuntime,
    type BlackBoxRallarRuntimeInstallationTarget
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts';
import {
    createBlackBoxBrowserRallarRuntimeDependency,
    type BlackBoxBrowserRallarRuntimeDependency
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts';
import type { BlackBoxRallarConnectionRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-connection-runtime.ts';
import { BlackBoxRallarVolatileLimits } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-volatile-limits.ts';

import { createSpaBrowserRallarRuntime } from '@shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import type { RallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/browser/browser-command-contracts.ts';

import {
    parseControlClientMessage,
    parseControlServerMessage,
    type ControlCommandEnvelope,
    type ControlRegisterEnvelope,
    type ControlResultEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';

import type { RallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import * as connectionHttp from '@shared-web/browser/connection/connection-http-api.ts';

import * as heartbeat from '@shared-web/browser/session/browser-session-heartbeat.ts';
import * as snapshots from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import * as auth from '@shared/api/auth.ts';

import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { createRallarBlackBoxControlService } from '../../../../apps/rallar-black-box-control-server/src/control-service.ts';
import '../../setup-browser-indexeddb.ts';

import { installFakeBroadcastChannelPerTest } from '../../shared-web/data/rallar-data-test-runtime.ts';
import { SimulatedWebSocket } from '../../shared/native-websocket-fixture.ts';

export function installCaptureApplicationTestEnvironment(): void {
    installFakeBroadcastChannelPerTest();
    beforeEach(() => {
        vi.spyOn(auth, 'readSession').mockReturnValue({
            clientId: 'client',
            sessionId: 'session',
            username: 'tester',
            accessToken: 'unit-test',
            expiresAtEpochMs: Date.now() + 60_000
        });
        vi.stubGlobal(
            'localStorage',
            {
                getItem: () => JSON.stringify(auth.readSession()),
                setItem: vi.fn(),
                removeItem: vi.fn()
            } satisfies Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
        );
        vi.spyOn(connectionHttp, 'readApiConfig').mockResolvedValue({
            apiBaseUrl: 'https://test.invalid',
            wsBaseUrl: 'wss://test.invalid',
            endpoints: { createWs: '/ws' }
        });
        vi.spyOn(connectionHttp, 'readIceCandidates').mockResolvedValue({ iceServers: [], expiresAtEpochMs: Date.now() + 60_000 });
        vi.spyOn(JsonWebSocketClient.prototype, 'connect').mockResolvedValue();
        vi.spyOn(snapshots, 'refreshStateSnapshots').mockResolvedValue({ clients: [], groups: [] });
        vi.spyOn(heartbeat, 'initHeartbeat').mockResolvedValue({ sessionId: 'session', generationId: 'test', stop: () => {} });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });
}

export interface CaptureApplicationRuntime {
    readonly events: BlackBoxRallarEvent[];
    readonly facade: BlackBoxBrowserRallarRuntimeDependency;
    readonly page: BlackBoxRallarRuntime;
    readonly runtime: RallarBlackBoxBrowserTestRuntime;
    readonly targetWindow: BlackBoxRallarRuntimeInstallationTarget;
}

export function createCaptureApplicationRuntime(
    readDocument: BlackBoxRallarConnectionRuntime.Input['readDocument'] = () => ({ timeOrigin: 1, origin: 'https://test.invalid' })
): CaptureApplicationRuntime {
    const events: BlackBoxRallarEvent[] = [];
    const volatileLimits = new BlackBoxRallarVolatileLimits();
    const facade = createBlackBoxBrowserRallarRuntimeDependency({ readVolatileSessionLimits: volatileLimits.get });
    const targetWindow: BlackBoxRallarRuntimeInstallationTarget = {
        __blackBoxRallarEmit: (event) => {
            events.push(event);
        }
    };
    const page = createBlackBoxRallarRuntime({
        facade,
        volatileLimits,
        targetWindow,
        clock: { now: Date.now },
        readDocument,
        delay: async () => {}
    });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { __blackBoxRallar: page }));
    return { events, facade, page, targetWindow, runtime: createDefaultRallarBlackBoxBrowserTestRuntime({ rallarRuntime: createSpaBrowserRallarRuntime() }) };
}

export function createCaptureController() {
    return createRallarBlackBoxControlService({
        dependencies: { now: () => 1_000, createCommandId: () => 'unused', createRunToken: () => 'unused' },
        config: {
            redaction: undefined,
            allowedCommandKinds: undefined,
            commandRateLimitMax: 100,
            commandRateLimitWindowMs: 1_000,
            runtimeRetentionBounds: { results: 10, events: 10, heartbeats: 10, reports: 10, commands: 10, stats: 10 }
        }
    });
}

export interface SerializedControllerExecution {
    readonly command: ControlCommandEnvelope;
    readonly result: RallarBlackBoxTestResult;
    readonly envelope: ControlResultEnvelope;
    readonly wire: string;
}

export async function executeSerializedControllerCommand(
    runtime: RallarBlackBoxBrowserTestRuntime,
    dispatch: ControlCommandEnvelope
): Promise<SerializedControllerExecution> {
    if (dispatch.agentId === undefined) {
        throw new Error('SDK execution requires an assigned control command.');
    }
    const decoded = parseControlServerMessage(JSON.stringify(dispatch), { runId: dispatch.runId, agentId: dispatch.agentId });
    if (!decoded.ok) {
        throw new Error(decoded.error);
    }
    const result = await runtime.execute({ ...decoded.envelope.command, commandId: decoded.envelope.commandId });
    const wire = JSON.stringify({
        kind: 'result',
        protocolVersion: 1,
        runId: dispatch.runId,
        agentId: dispatch.agentId,
        commandId: dispatch.commandId,
        ok: result.ok,
        replayed: result.replayed === true,
        result
    });
    const parsed = parseControlClientMessage(wire);
    if (!parsed.ok || parsed.envelope.kind !== 'result') {
        throw new Error('Actual SDK execution did not return a serialized control result.');
    }
    return { command: decoded.envelope, result, envelope: parsed.envelope, wire };
}

export function readSocketRegistration(socket: SimulatedWebSocket): ControlRegisterEnvelope {
    const parsed = socket.sent.map((wire) => parseControlClientMessage(wire)).find((candidate) => candidate.ok && candidate.envelope.kind === 'register');
    if (!parsed?.ok || parsed.envelope.kind !== 'register') {
        throw new Error('Actual control consumer did not serialize its registration.');
    }
    return parsed.envelope;
}

export function readSocketResult(socket: SimulatedWebSocket, commandId: string): ControlResultEnvelope | undefined {
    for (const wire of socket.sent) {
        const parsed = parseControlClientMessage(wire);
        if (parsed.ok && parsed.envelope.kind === 'result' && parsed.envelope.commandId === commandId) {
            return parsed.envelope;
        }
    }
    return undefined;
}

export async function executeSocketCommand(socket: SimulatedWebSocket, dispatch: ControlCommandEnvelope): Promise<ControlResultEnvelope> {
    await socket.receive(JSON.stringify(dispatch));
    await vi.waitFor(() => expect(readSocketResult(socket, dispatch.commandId)).toBeDefined());
    const result = readSocketResult(socket, dispatch.commandId);
    if (result === undefined) {
        throw new Error('Actual control consumer did not return the dispatched command result.');
    }
    return result;
}
