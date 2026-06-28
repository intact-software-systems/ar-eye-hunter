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
            reconnectAttempt: 0,
            sentCount: 3,
            receivedCount: 1,
        },
        state: {
            status: 'waiting',
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
        expect(root.querySelector('[data-runtime-state]')?.textContent).toBe('waiting');
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
});
