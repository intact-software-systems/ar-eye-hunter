import { describe, expect, it } from 'vitest';
import { resolveRallarBlackBoxBootstrapConfig } from '../../../packages/shared-test/rallar-bb-test/browser-control-agent-config.ts';
import {
    createRallarBlackBoxBrowserControlAgent,
    toInitialControlSnapshot,
    type RallarBlackBoxBrowserControlAgent
} from '../../../packages/shared-test/rallar-bb-test/browser-control-agent.ts';
import type {
    RallarBlackBoxAgentControlClient,
    RallarBlackBoxControlConnectOptions,
    RallarBlackBoxControlSnapshot,
    RallarBlackBoxControlSnapshotListener
} from '../../../packages/shared-test/rallar-bb-test/control-client.ts';
import { createRallarBlackBoxTestRuntime } from '../../../packages/shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

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

interface TestControlAgent {
    readonly agent: RallarBlackBoxBrowserControlAgent;
    readonly controlClient: FakeAgentControlClient;
}

function createTestControlAgent(search: string): TestControlAgent {
    const controlClient = new FakeAgentControlClient();
    const agent = createRallarBlackBoxBrowserControlAgent({
        bootstrap: resolveRallarBlackBoxBootstrapConfig(search, {}, ''),
        agentRuntime: { runtime: createRallarBlackBoxTestRuntime() },
        controlClient
    });
    return { agent, controlClient };
}

describe('browser control-agent lifecycle', () => {
    it('creates an idle snapshot before startup', () => {
        const { agent } = createTestControlAgent('?mode=control&provider=simulated&autoConnect=0&runId=run-1&agentId=agent-1');

        const snapshot = agent.getSnapshot();
        expect(snapshot.bootstrap.mode).toBe('control-agent');
        expect(snapshot.bootstrap.runId).toBe('run-1');
        expect(snapshot.bootstrap.agentId).toBe('agent-1');
        expect(snapshot.control).toEqual(toInitialControlSnapshot(snapshot.bootstrap));
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
