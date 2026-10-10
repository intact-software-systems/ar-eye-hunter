import { describe, expect, it, vi } from 'vitest';

import { decodeBlackBoxRallarConnectionConfig } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts';
import type { RallarBlackBoxBootstrapEnvironment } from '@shared-test/rallar-bb-test/browser-control-agent/resolve-launch-value.ts';
import * as sessionHttp from '@shared-web/browser/auth/session-http-api.ts';
import * as connectionHttp from '@shared-web/browser/connection/connection-http-api.ts';
import * as auth from '@shared/api/auth.ts';

import { resolveRallarBlackBoxBootstrapConfig } from '../../../packages/shared-test/rallar-bb-test/browser-control-agent-config.ts';
import {
    createRallarBlackBoxBrowserControlAgent,
    type RallarBlackBoxBrowserControlAgent
} from '../../../packages/shared-test/rallar-bb-test/browser-control-agent.ts';
import type {
    RallarBlackBoxAgentControlClient,
    RallarBlackBoxControlConnectOptions,
    RallarBlackBoxControlSnapshot,
    RallarBlackBoxControlSnapshotListener
} from '../../../packages/shared-test/rallar-bb-test/control-client.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '../../../packages/shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

import { readHeadlessWorkerConfig } from '../../../apps/rallar-black-box/src/headless-worker-config.ts';
import {
    createCaptureApplicationRuntime,
    installCaptureApplicationTestEnvironment,
    type CaptureApplicationRuntime
} from './rallar-browser-runtime/capture-application-test-runtime.ts';

interface LaunchCaptureAgent {
    readonly application: CaptureApplicationRuntime;
    readonly agent: RallarBlackBoxBrowserControlAgent;
    readonly controlClient: FakeAgentControlClient;
}

interface TestControlAgent {
    readonly agent: RallarBlackBoxBrowserControlAgent;
    readonly controlClient: FakeAgentControlClient;
}

const WORKER_HOST_ENVIRONMENT = {
    RALLAR_BLACK_BOX_SPA_URL: 'https://test.invalid',
    RALLAR_BLACK_BOX_CONTROL_URL: 'wss://control.invalid/control',
    RALLAR_API_BASE_URL: 'https://test.invalid',
    RALLAR_BLACK_BOX_RUN_ID: 'host-launch-run',
    RALLAR_BLACK_BOX_ROOM_ID: 'host-launch-room',
    RALLAR_BLACK_BOX_USERNAME: 'tester',
    RALLAR_BLACK_BOX_PASSWORD: 'test-fixture',
    RALLAR_APPLICATION_ID: 'app',
    RALLAR_WORKSPACE_ID: 'main'
};
const HOST_AGENT_SEARCH = '?mode=control&provider=browser-rallar&autoConnect=0&apiBaseUrl=https%3A%2F%2Ftest.invalid&applicationId=app';

class FakeAgentControlClient implements RallarBlackBoxAgentControlClient {
    readonly connections: RallarBlackBoxControlConnectOptions[] = [];
    disposed = false;
    private readonly listeners = new Set<RallarBlackBoxControlSnapshotListener>();

    subscribe(listener: RallarBlackBoxControlSnapshotListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    connect(connection: RallarBlackBoxControlConnectOptions): void {
        this.connections.push(connection);
    }

    dispose(): void {
        this.disposed = true;
    }

    publishSnapshot(snapshot: RallarBlackBoxControlSnapshot): void {
        this.listeners.forEach((listener) => listener(snapshot));
    }
}

function createTestControlAgent(search: string): TestControlAgent {
    const controlClient = new FakeAgentControlClient();
    const agent = createRallarBlackBoxBrowserControlAgent({
        bootstrap: resolveRallarBlackBoxBootstrapConfig(search, {}, ''),
        agentRuntime: { runtime: createDefaultRallarBlackBoxTestRuntime() },
        controlClient
    });
    return { agent, controlClient };
}

function createLaunchCaptureAgent(search: string, env: RallarBlackBoxBootstrapEnvironment): LaunchCaptureAgent {
    const bootstrap = resolveRallarBlackBoxBootstrapConfig(search, env, '');
    const session = auth.readSession();
    if (session === undefined) {
        throw new Error('Capture application fixture must provide an authenticated session.');
    }
    vi.mocked(auth.readSession).mockReturnValue({ ...session, sessionId: bootstrap.sessionId });
    vi.spyOn(sessionHttp, 'loginToApi').mockResolvedValue({ ...session, sessionId: bootstrap.sessionId });
    const application = createCaptureApplicationRuntime();
    const controlClient = new FakeAgentControlClient();
    const agent = createRallarBlackBoxBrowserControlAgent({
        bootstrap,
        agentRuntime: { runtime: application.runtime },
        controlClient
    });
    return { application, agent, controlClient };
}

installCaptureApplicationTestEnvironment();

describe('browser control-agent lifecycle', () => {
    it('creates an idle snapshot before startup', () => {
        const { agent } = createTestControlAgent('?mode=control&provider=simulated&autoConnect=0&runId=run-1&agentId=agent-1');

        const snapshot = agent.getSnapshot();
        expect(snapshot.bootstrap.mode).toBe('control-agent');
        expect(snapshot.bootstrap.runId).toBe('run-1');
        expect(snapshot.bootstrap.agentId).toBe('agent-1');
        expect(snapshot.control).toEqual({
            state: 'idle',
            url: 'ws://localhost:5180/control',
            reconnectAttempt: 0,
            sentCount: 0,
            receivedCount: 0
        });
        expect(snapshot.runState).toBe('waiting');

        agent.dispose();
    });

    it('notifies subscribers when snapshot changes', () => {
        const { agent } = createTestControlAgent('?mode=control&provider=simulated&autoConnect=0&runId=run-2&agentId=agent-2');
        let callCount = 0;
        const unsubscribe = agent.subscribe(() => {
            callCount += 1;
        });

        agent.recordStatus('Custom status update');

        expect(callCount).toBe(1);
        expect(agent.getSnapshot().lastAction).toBe('Custom status update');

        unsubscribe();
        agent.dispose();
    });

    it('mirrors control connection snapshots until disposed', () => {
        const { agent, controlClient } = createTestControlAgent('?mode=control&provider=simulated&runId=run-7&agentId=agent-7');
        const registered: RallarBlackBoxControlSnapshot = {
            state: 'registered',
            url: 'ws://control.example.test/control',
            reconnectAttempt: 0,
            sentCount: 1,
            receivedCount: 0
        };

        controlClient.publishSnapshot(registered);
        expect(agent.getSnapshot().control).toEqual(registered);

        agent.dispose();
        controlClient.publishSnapshot({ ...registered, state: 'reconnecting' });

        expect(controlClient.disposed).toBe(true);
        expect(agent.getSnapshot().control).toEqual(registered);
    });

    it('configures without opening a control socket when autoConnect is disabled', async () => {
        const { agent, controlClient } = createTestControlAgent('?mode=control&provider=simulated&autoConnect=0&runId=run-3&agentId=agent-3');

        expect((await agent.start()).right).toBe('configured');

        expect(controlClient.connections).toEqual([]);
        expect(agent.getSnapshot().lastAction).toBe('Remote control agent configured');

        agent.dispose();
    });

    it('opens the control socket only when autoConnect is enabled', async () => {
        const { agent, controlClient } = createTestControlAgent(
            '?mode=control&provider=simulated&autoConnect=1&controlUrl=ws%3A%2F%2Fcontrol.example.test%2Fcontrol&runId=run-4&agentId=agent-4'
        );

        expect((await agent.start()).right).toBe('connecting');

        expect(controlClient.connections).toEqual([{
            url: 'ws://control.example.test/control',
            runId: 'run-4',
            agentId: 'agent-4',
            token: undefined,
            finalReportUploadUrl: undefined,
            completedCommandIds: []
        }]);
        expect(agent.getSnapshot().lastAction).toBe('Remote control agent configured; connecting');

        agent.dispose();
    });

    it('hands the launch control token and final report upload URL to the control connection', async () => {
        const { agent, controlClient } = createTestControlAgent(
            '?mode=control&provider=simulated&autoConnect=1&controlUrl=ws%3A%2F%2Fcontrol.example.test%2Fcontrol' +
                '&controlToken=run-token&reportUploadUrl=http%3A%2F%2Fcontrol.example.test%2Freport&runId=run-5&agentId=agent-5'
        );

        expect((await agent.start()).right).toBe('connecting');

        expect(controlClient.connections).toHaveLength(1);
        expect(controlClient.connections[0]).toHaveProperty('token', 'run-token');
        expect(controlClient.connections[0]).toHaveProperty('finalReportUploadUrl', 'http://control.example.test/report');

        agent.dispose();
    });

    it('returns an invalid browser-rallar provider config as the start failure', async () => {
        const { agent, controlClient } = createTestControlAgent('?mode=control&provider=browser-rallar&autoConnect=1&runId=run-6&agentId=agent-6');

        const started = await agent.start();

        expect(started.left).toBe('browser-rallar provider requires a real Rallar API base URL.');
        expect(controlClient.connections).toEqual([]);
        expect(agent.getSnapshot()).toMatchObject({
            runState: 'failed',
            lastAction: 'Remote control bootstrap failed',
            lastError: 'browser-rallar provider requires a real Rallar API base URL.'
        });
        expect(agent.getSnapshot().state.events.map((event) => event.topic))
            .toContain('rallar.bb.provider.browser_rallar.config_invalid');

        agent.dispose();
    });

    it('refuses to start on launch values it cannot read, before configuring the runtime or connecting', async () => {
        const { agent, controlClient } = createTestControlAgent(
            '?mode=control&provider=browser-rallr&autoConnect=1&runnerAgentCount=many&runId=run-8&agentId=agent-8'
        );
        const failure = 'The agent launch cannot be read: provider must be one of simulated, browser-rallar, not \'browser-rallr\'. ' +
            'runnerAgentCount must be a positive integer, not \'many\'.';

        const started = await agent.start();

        expect(started.left).toBe(failure);
        expect(controlClient.connections).toEqual([]);
        expect(agent.getSnapshot()).toMatchObject({
            runState: 'failed',
            bootstrapping: false,
            busy: false,
            lastAction: 'Remote control bootstrap failed',
            lastError: failure
        });
        expect(agent.getSnapshot().state.currentConfig).toBeUndefined();
        expect(agent.getSnapshot().state.commandHistory).toEqual([]);

        agent.dispose();
    });

    it('does not start or connect after disposal', async () => {
        const { agent, controlClient } = createTestControlAgent(
            '?mode=control&provider=simulated&autoConnect=1&controlUrl=ws%3A%2F%2Fcontrol.example.test%2Fcontrol&runId=run-5&agentId=agent-5'
        );

        agent.dispose();
        expect((await agent.start()).left).toBe('Browser control agent is disposed.');

        expect(controlClient.connections).toEqual([]);
    });
});

describe('host capture through worker launch and real SDK application', () => {
    it.each(
        [
            { host: undefined, run: undefined, mode: 'signaling', origin: 'product-default' },
            { host: 'off', run: undefined, mode: 'off', origin: 'host' },
            { host: 'signaling', run: undefined, mode: 'signaling', origin: 'host' },
            { host: 'native', run: undefined, mode: 'native', origin: 'host' },
            { host: 'off', run: 'native', mode: 'native', origin: 'run' },
            { host: 'native', run: 'off', mode: 'off', origin: 'run' }
        ] as const
    )('applies generated worker host $host and run $run as $mode/$origin', async (selection) => {
        const worker = readHeadlessWorkerConfig({
            env: {
                ...WORKER_HOST_ENVIRONMENT,
                ...(selection.host === undefined ? {} : { RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: selection.host })
            }
        });
        const url = new URL(worker.agents[0].url);
        const { application, agent, controlClient } = createLaunchCaptureAgent(url.search, {});
        try {
            expect.soft(url.searchParams.get('rtcCaptureMode')).toBe(selection.host ?? null);
            expect((await agent.start()).right).toBe('connecting');
            expect(controlClient.connections).toHaveLength(1);
            const command = selection.run === undefined
                ? { kind: 'rtc.connect' as const, commandId: 'worker-host-connect', roomId: '', applicationId: 'app', workspaceId: 'main' }
                : {
                    kind: 'recipe.run' as const,
                    commandId: 'worker-host-run',
                    rtcCaptureMode: selection.run,
                    recipe: {
                        schemaVersion: 1 as const,
                        recipeId: 'worker-host',
                        commands: [{ kind: 'rtc.connect' as const, commandId: 'worker-host-connect', roomId: '', applicationId: 'app', workspaceId: 'main' }]
                    }
                };
            const result = await application.runtime.execute(command);
            expect(result.ok, result.error?.code).toBe(true);
            expect(application.facade.rtcCapture()).toMatchObject({
                configuration: { mode: selection.mode, origin: selection.origin },
                application: { status: 'applied', mode: selection.mode },
                connectionId: { status: 'observed', value: expect.any(String) }
            });
        }
        finally {
            agent.dispose();
            await application.page.close();
        }
    });

    it.each(
        [
            { query: 'off', environment: 'native', mode: 'off' },
            { query: 'native', environment: 'off', mode: 'native' },
            { query: '', environment: 'native', mode: 'native' },
            { query: '  ', environment: 'off', mode: 'off' },
            { query: undefined, environment: 'signaling', mode: 'signaling' }
        ] as const
    )('applies query $query over matching environment $environment as host $mode', async (selection) => {
        const search = new URLSearchParams(HOST_AGENT_SEARCH);
        if (selection.query !== undefined) {
            search.set('rtcCaptureMode', selection.query);
        }
        const { application, agent } = createLaunchCaptureAgent(search.toString(), { VITE_RALLAR_RTC_CAPTURE_MODE: selection.environment });
        try {
            expect((await agent.start()).right).toBe('configured');
            expect(
                (await application.runtime.execute({
                    kind: 'rtc.connect',
                    commandId: 'launch-host-connect',
                    roomId: '',
                    applicationId: 'app',
                    workspaceId: 'main'
                })).ok
            )
                .toBe(true);
            expect(application.facade.rtcCapture()).toMatchObject({
                configuration: { mode: selection.mode, origin: 'host' },
                application: { status: 'applied', mode: selection.mode }
            });
        }
        finally {
            agent.dispose();
            await application.page.close();
        }
    });

    it.each([
        { query: 'not-a-capture-mode', environment: 'native', launchKey: 'rtcCaptureMode' },
        { query: undefined, environment: 'not-a-capture-mode', launchKey: 'VITE_RALLAR_RTC_CAPTURE_MODE' }
    ])('refuses invalid $launchKey before Configure and control effects without retaining raw input', async (selection) => {
        const search = new URLSearchParams(HOST_AGENT_SEARCH);
        search.set('autoConnect', '1');
        if (selection.query !== undefined) {
            search.set('rtcCaptureMode', selection.query);
        }
        const { application, agent, controlClient } = createLaunchCaptureAgent(search.toString(), { VITE_RALLAR_RTC_CAPTURE_MODE: selection.environment });
        try {
            const started = await agent.start();
            expect.soft(started.left).toBeDefined();
            expect.soft(agent.getSnapshot().bootstrap.issues).toEqual([
                expect.objectContaining({ launchKey: selection.launchKey, message: expect.any(String) })
            ]);
            expect.soft(JSON.stringify(agent.getSnapshot().bootstrap.issues)).not.toContain('not-a-capture-mode');
            expect.soft(controlClient.connections).toHaveLength(0);
            expect.soft(application.runtime.state().currentConfig === undefined).toBe(true);
            expect.soft(application.runtime.state().commandHistory.map((command) => command.kind)).toEqual([]);
            expect(application.facade.rtcCapture()).toBeUndefined();
        }
        finally {
            agent.dispose();
            await application.page.close();
        }
    });

    it('rejects invalid worker capture before producing any browser launch config', () => {
        const read = () => readHeadlessWorkerConfig({ env: { ...WORKER_HOST_ENVIRONMENT, RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: 'not-a-capture-mode' } });
        expect(read).toThrow(/RALLAR_BLACK_BOX_RTC_CAPTURE_MODE/);
    });

    it.each(['active', 'pending'] as const)('retains the worker host receipt when desired defaults change during a %s connection', async (state) => {
        const worker = readHeadlessWorkerConfig({ env: { ...WORKER_HOST_ENVIRONMENT, RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: 'native' } });
        const { application, agent } = createLaunchCaptureAgent(new URL(worker.agents[0].url).search, {});
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        vi.mocked(connectionHttp.readIceCandidates).mockImplementation(async () => {
            entered.resolve();
            await release.promise;
            return { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 };
        });
        try {
            expect((await agent.start()).right).toBe('connecting');
            const connecting = application.runtime.execute({
                kind: 'rtc.connect',
                commandId: 'immutable-worker-host',
                roomId: '',
                applicationId: 'app',
                workspaceId: 'main'
            });
            await entered.promise;
            if (state === 'active') {
                release.resolve();
                expect((await connecting).ok).toBe(true);
            }
            const before = application.facade.rtcCapture();
            application.facade.setDefaults({ applicationId: 'app', rtc: { captureMode: 'off' } });
            if (state === 'pending') {
                expect(before).toBeUndefined();
                release.resolve();
                expect((await connecting).ok).toBe(true);
            }
            const receipt = application.facade.rtcCapture();
            expect.soft(receipt).toMatchObject({
                configuration: { mode: 'native', origin: 'host' },
                application: { status: 'applied', mode: 'native' }
            });
            if (state === 'active') {
                expect(receipt).toEqual(before);
            }
        }
        finally {
            release.resolve();
            agent.dispose();
            await application.page.close();
        }
    });
});

describe('unscoped host capture through the page decoder and real SDK', () => {
    it.each(
        [
            { host: undefined, mode: 'off', origin: 'product-default' },
            { host: 'off', mode: 'off', origin: 'host' },
            { host: 'signaling', mode: 'signaling', origin: 'host' },
            { host: 'native', mode: 'native', origin: 'host' }
        ] as const
    )('retains no-application host $host as $mode/$origin without inventing application defaults', async (selection) => {
        const application = createCaptureApplicationRuntime();
        const setDefaults = vi.spyOn(application.facade, 'setDefaults');
        const decoded = decodeBlackBoxRallarConnectionConfig({
            connection: 'default',
            rallar: {
                apiBaseUrl: 'https://test.invalid',
                ...(selection.host === undefined ? {} : { rtc: { captureMode: selection.host } })
            }
        });
        try {
            const connected = await application.page.connect(decoded);
            expect(connected.status).toBe('connected');
            expect(connected.applicationId).toBeUndefined();
            expect(connected.workspaceId).toBeUndefined();
            expect(connected.scope).toBeUndefined();
            expect(setDefaults.mock.calls.flatMap(([defaults]) => defaults?.applicationId === undefined ? [] : [defaults.applicationId])).toEqual([]);
            const receipt = application.facade.rtcCapture();
            expect.soft(receipt?.configuration).toEqual({ mode: selection.mode, origin: selection.origin });
            expect(connected.rtcCapture).toEqual({ status: 'observed', value: receipt });
            expect(receipt?.connectionId).toMatchObject({ status: 'observed', value: expect.any(String) });
            if (selection.mode === 'off') {
                expect(receipt?.application).toEqual({ status: 'applied', mode: 'off' });
            }
            else if (receipt?.application.status === 'applied') {
                expect(receipt.application.mode).toBe(selection.mode);
            }
            else {
                expect(receipt?.application).toMatchObject({ status: 'unavailable', reason: expect.any(String) });
                expect(['sink-unavailable', 'unsupported', 'initialization-failed']).toContain(receipt?.application.reason);
            }
        }
        finally {
            await application.page.close();
        }
    });
});
