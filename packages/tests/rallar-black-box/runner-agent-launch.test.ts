import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '../../shared/api/api-config.ts';
import {
    resolveRallarBlackBoxBootstrapConfig,
} from '../../shared-test/rallar-bb-test/browser-control-agent-config.ts';
import {
    appModeFromValue,
    appTabFromValue,
} from '../../../apps/rallar-black-box/src/app-tabs.ts';
import {
    normalizeAppNavigation,
} from '../../../apps/rallar-black-box/src/legacy/shell/navigation.ts';
import {
    createRunnerAgentLaunchUrl,
    readRunnerAgentSessionTicketFromHash,
} from '../../../apps/rallar-black-box/src/runner-agent-launch.ts';

const ticketMocks = vi.hoisted(() => ({
    configureApiClient: vi.fn(),
    consumeAgentSessionTicket: vi.fn(),
}));

vi.mock('@shared-web/browser/api-client-config.ts', () => ({
    configureApiClient: ticketMocks.configureApiClient,
}));
vi.mock('@shared-web/browser/api-integration.ts', () => ({
    consumeAgentSessionTicket: ticketMocks.consumeAgentSessionTicket,
}));

import {
    consumeBootstrapAgentSessionTicket,
    scrubAgentSessionTicketFromUrl,
} from '../../../apps/rallar-black-box/src/legacy/shell/auth/agent-session-ticket.ts';

afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

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

    it('boots the generated Workbench alias, consumes its ticket once, and scrubs only the ticket fragment', async () => {
        const session: AuthSession = {
            clientId: 'controller-01-client',
            accessToken: 'controller-01-access-token',
            username: 'alice',
            sessionId: 'controller-01-session',
            expiresAtEpochMs: 9_999,
        };
        ticketMocks.consumeAgentSessionTicket.mockResolvedValue(session);

        const generated = createRunnerAgentLaunchUrl({
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
        });
        const launchUrl = new URL(generated);
        const fragment = new URLSearchParams(launchUrl.hash.slice(1));
        fragment.set('trace', 'keep');
        fragment.set('pane', 'evidence');
        launchUrl.hash = fragment.toString();

        const bootstrap = resolveRallarBlackBoxBootstrapConfig(
            launchUrl.search,
            {},
            launchUrl.hash,
        );
        const requestedTab = appTabFromValue(
            launchUrl.searchParams.get('tab'),
        );
        const navigation = normalizeAppNavigation({
            mode: appModeFromValue(launchUrl.searchParams.get('workspace')),
            tab: requestedTab,
        });

        expect(bootstrap).toMatchObject({
            mode: 'control-agent',
            autoConnect: true,
            providerMode: 'browser-rallar',
            controlUrl: 'wss://control.example.test/control',
            runId: 'run-1',
            agentId: 'controller-01',
            roomId: 'room-1',
            apiBaseUrl: 'https://api.example.test',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            actor: 'alice',
            sessionId: 'controller-01-session',
            rallarAuthStorage: 'session',
            rallarAgentSessionTicket: 'secret-agent-ticket',
            rallarRestoreSession: true,
        });
        expect(requestedTab).toBe('local-workbench');
        expect(navigation).toEqual({
            mode: 'black-box-runner',
            tab: 'advanced',
            advancedSurface: 'workbench',
        });

        const firstConsume = consumeBootstrapAgentSessionTicket(
            bootstrap.rallarAgentSessionTicket!,
            bootstrap.apiBaseUrl,
        );
        const duplicateConsume = consumeBootstrapAgentSessionTicket(
            bootstrap.rallarAgentSessionTicket!,
            bootstrap.apiBaseUrl,
        );

        expect(duplicateConsume).toBe(firstConsume);
        await expect(firstConsume).resolves.toEqual(session);
        expect(ticketMocks.configureApiClient).toHaveBeenCalledOnce();
        expect(ticketMocks.configureApiClient).toHaveBeenCalledWith({
            apiBaseUrl: 'https://api.example.test',
        });
        expect(ticketMocks.consumeAgentSessionTicket).toHaveBeenCalledOnce();
        expect(ticketMocks.consumeAgentSessionTicket).toHaveBeenCalledWith({
            ticket: 'secret-agent-ticket',
        });

        const replaceState = vi.fn();
        vi.stubGlobal('window', {
            location: {
                hash: launchUrl.hash,
                href: launchUrl.toString(),
            },
            history: { replaceState },
        });
        vi.stubGlobal('document', { title: 'Rallar Black Box' });

        scrubAgentSessionTicketFromUrl();

        expect(replaceState).toHaveBeenCalledOnce();
        const scrubbed = new URL(String(replaceState.mock.calls[0][2]));
        expect(scrubbed.search).toBe(launchUrl.search);
        expect(scrubbed.hash).toBe('#trace=keep&pane=evidence');
        expect(scrubbed.href).not.toContain('secret-agent-ticket');
    });
});
