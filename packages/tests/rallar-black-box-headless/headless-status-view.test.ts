// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { renderHeadlessStatus } from '../../../apps/rallar-black-box-headless/src/status-view.ts';
import type { RallarBlackBoxBrowserControlAgentSnapshot } from '../../../packages/shared-test/rallar-bb-test/browser-control-agent.ts';

function snapshot(): RallarBlackBoxBrowserControlAgentSnapshot {
    return {
        bootstrapping: false,
        busy: false,
        runState: 'waiting',
        lastAction: 'Remote control agent configured; connecting',
        bootstrap: {
            mode: 'control-agent',
            autoConnect: true,
            providerMode: 'browser-rallar',
            controlUrl: 'wss://control.example.test/control',
            runId: 'run-1',
            agentId: 'agent-1',
            environment: 'hetzner',
            apiBaseUrl: 'https://api.example.test',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            actor: 'agent-1',
            sessionId: 'agent-1',
            roomId: 'room-1',
            transport: 'realtime',
            rallarRegister: false,
            rallarAuthStorage: 'local',
            rallarRestoreSession: false,
            rallarLogoutOnClose: false,
            rallarLeaveRoomOnClose: false,
            source: 'url',
        },
        control: {
            state: 'registered',
            url: 'wss://control.example.test/control',
            runId: 'run-1',
            agentId: 'agent-1',
            lastHeartbeatAtEpochMs: 2_000,
            reconnectAttempt: 0,
            sentCount: 3,
            receivedCount: 1,
            identity: {
                principalId: 'agent-1',
                clientId: 'agent-1',
                sessionId: 'agent-1',
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'room-1',
                region: 'eu-north',
                provider: 'hetzner',
                datacenter: 'fsn1',
                hostId: 'host-1',
            },
        },
        state: {
            status: 'configured',
            commandHistory: [],
            events: [],
            failures: [],
            resultCache: {},
        },
    };
}

describe('headless status view', () => {
    it('renders basic agent and control information for local inspection', () => {
        const root = document.createElement('main');

        renderHeadlessStatus(root, snapshot());

        expect(root.querySelector('[data-agent-id]')?.textContent).toBe('agent-1');
        expect(root.querySelector('[data-run-id]')?.textContent).toBe('run-1');
        expect(root.querySelector('[data-control-state]')?.textContent).toBe('registered');
        expect(root.querySelector('[data-runtime-state]')?.textContent).toBe('configured');
        expect(root.querySelector('[data-application-id]')?.textContent).toBe('rallar-server');
        expect(root.querySelector('[data-workspace-id]')?.textContent).toBe('default');
        expect(root.querySelector('[data-group-id]')?.textContent).toBe('room-1');
        expect(root.querySelector('[data-fleet-region]')?.textContent).toBe('eu-north');
        expect(root.querySelector('[data-fleet-provider]')?.textContent).toBe('hetzner');
        expect(root.querySelector('[data-fleet-datacenter]')?.textContent).toBe('fsn1');
        expect(root.querySelector('[data-last-heartbeat]')?.textContent).toBe('2000');
        expect(root.querySelector('[data-reconnect-count]')?.textContent).toBe('0');
        expect(root.textContent).toContain('Remote control agent configured; connecting');
    });

    it('renders untrusted agent values as text, not markup', () => {
        const root = document.createElement('main');
        const unsafe = '<img src=x onerror=alert(1)>';

        renderHeadlessStatus(root, {
            ...snapshot(),
            lastAction: unsafe,
            lastError: unsafe,
            bootstrap: {
                ...snapshot().bootstrap,
                agentId: unsafe,
            },
        });

        expect(root.querySelector('img')).toBeNull();
        expect(root.querySelector('[data-agent-id]')?.textContent).toBe(unsafe);
        expect(root.querySelector('[data-last-action]')?.textContent).toBe(unsafe);
        expect(root.querySelector('[data-last-error]')?.textContent).toBe(unsafe);
    });

    it('warns when global fleet identity is incomplete', () => {
        const root = document.createElement('main');

        renderHeadlessStatus(root, {
            ...snapshot(),
            control: {
                ...snapshot().control,
                identity: undefined,
            },
            bootstrap: {
                ...snapshot().bootstrap,
                applicationId: '',
                workspaceId: '',
                roomId: '',
                fleetRegion: undefined,
                fleetProvider: undefined,
            },
        });

        expect(root.querySelector('[data-fleet-identity-warning]')?.textContent).toContain(
            'Missing global fleet identity',
        );
    });
});
