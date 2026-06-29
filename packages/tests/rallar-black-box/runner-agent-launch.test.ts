import { describe, expect, it } from 'vitest';
import {
    createRunnerAgentLaunchUrl,
    readRunnerAgentSessionTicketFromHash,
} from '../../../apps/rallar-black-box/src/runner-agent-launch.ts';

describe('rallar-black-box runner agent launch links', () => {
    it('builds one-time same-user agent links without leaking auth secrets in query params', () => {
        const launchUrl = createRunnerAgentLaunchUrl({
            origin: 'https://blackbox.example.test',
            providerMode: 'browser-rallar',
            controlWsUrl: 'wss://control.example.test/control',
            runId: 'run-1',
            agentId: 'controller-01',
            groupId: 'room-1',
            apiBaseUrl: 'https://api.example.test',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            actor: 'alice',
            sessionId: 'controller-01-session',
            authStorage: 'session',
            agentSessionTicket: 'secret-agent-ticket',
            controlToken: 'control-token',
        });

        const url = new URL(launchUrl);
        expect(url.searchParams.get('mode')).toBe('control');
        expect(url.searchParams.get('workspace')).toBe('black-box-runner');
        expect(url.searchParams.get('tab')).toBe('local-workbench');
        expect(url.searchParams.get('provider')).toBe('browser-rallar');
        expect(url.searchParams.get('autoConnect')).toBe('1');
        expect(url.searchParams.get('agentId')).toBe('controller-01');
        expect(url.searchParams.get('actor')).toBe('alice');
        expect(url.searchParams.get('sessionId')).toBe('controller-01-session');
        expect(url.searchParams.get('rallarAuthStorage')).toBe('session');
        expect(url.searchParams.get('rallarRestoreSession')).toBe('1');
        expect(url.searchParams.get('controlToken')).toBe('control-token');
        expect(url.search).not.toContain('secret-agent-ticket');
        expect(url.searchParams.get('rallarPassword')).toBeNull();
        expect(url.searchParams.get('accessToken')).toBeNull();
        expect(readRunnerAgentSessionTicketFromHash(url.hash)).toBe('secret-agent-ticket');
    });
});
