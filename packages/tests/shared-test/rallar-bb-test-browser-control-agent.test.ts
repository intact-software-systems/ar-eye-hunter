import { describe, expect, it, vi } from 'vitest';
import { createRallarBlackBoxBrowserControlAgent, initialControlSnapshot } from '../../../packages/shared-test/rallar-bb-test/browser-control-agent.ts';
import { RallarBlackBoxControlClient } from '../../../packages/shared-test/rallar-bb-test/control-client.ts';

describe('browser control-agent lifecycle', () => {
    it('creates an idle snapshot before startup', () => {
        const agent = createRallarBlackBoxBrowserControlAgent({
            search: '?mode=control&provider=simulated&autoConnect=0&runId=run-1&agentId=agent-1',
            env: {}
        });

        const snapshot = agent.getSnapshot();
        expect(snapshot.bootstrap.mode).toBe('control-agent');
        expect(snapshot.bootstrap.runId).toBe('run-1');
        expect(snapshot.bootstrap.agentId).toBe('agent-1');
        expect(snapshot.control).toEqual(initialControlSnapshot(snapshot.bootstrap));
        expect(snapshot.runState).toBe('waiting');

        agent.dispose();
    });

    it('notifies subscribers when snapshot changes', () => {
        const agent = createRallarBlackBoxBrowserControlAgent({
            search: '?mode=control&provider=simulated&autoConnect=0&runId=run-2&agentId=agent-2',
            env: {}
        });
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

    it('configures without opening a control socket when autoConnect is disabled', async () => {
        const connectSpy = vi.spyOn(RallarBlackBoxControlClient.prototype, 'connect');
        const agent = createRallarBlackBoxBrowserControlAgent({
            search: '?mode=control&provider=simulated&autoConnect=0&runId=run-3&agentId=agent-3',
            env: {}
        });

        await agent.start();

        expect(connectSpy).not.toHaveBeenCalled();
        expect(agent.getSnapshot().lastAction).toBe('Remote control agent configured');

        connectSpy.mockRestore();
        agent.dispose();
    });

    it('opens the control socket only when autoConnect is enabled', async () => {
        const connectSpy = vi
            .spyOn(RallarBlackBoxControlClient.prototype, 'connect')
            .mockImplementation(() => undefined);
        const agent = createRallarBlackBoxBrowserControlAgent({
            search: '?mode=control&provider=simulated&autoConnect=1&controlUrl=ws%3A%2F%2Fcontrol.example.test%2Fcontrol&runId=run-4&agentId=agent-4',
            env: {}
        });

        await agent.start();

        expect(connectSpy).toHaveBeenCalledWith({
            url: 'ws://control.example.test/control',
            runId: 'run-4',
            agentId: 'agent-4',
            token: undefined
        });
        expect(agent.getSnapshot().lastAction).toBe('Remote control agent configured; connecting');

        connectSpy.mockRestore();
        agent.dispose();
    });

    it('does not start or connect after disposal', async () => {
        const connectSpy = vi
            .spyOn(RallarBlackBoxControlClient.prototype, 'connect')
            .mockImplementation(() => undefined);
        const agent = createRallarBlackBoxBrowserControlAgent({
            search: '?mode=control&provider=simulated&autoConnect=1&controlUrl=ws%3A%2F%2Fcontrol.example.test%2Fcontrol&runId=run-5&agentId=agent-5',
            env: {}
        });

        agent.dispose();
        await expect(agent.start()).rejects.toThrow('Browser control agent is disposed.');

        expect(connectSpy).not.toHaveBeenCalled();

        connectSpy.mockRestore();
    });
});
