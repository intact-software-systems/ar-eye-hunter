import type { AuthSessionStorageKind } from '@shared/api/auth.ts';
import type { RallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';

export type RunnerAgentLaunchInput = Readonly<{
    origin: string;
    providerMode: RallarBlackBoxBootstrapConfig['providerMode'];
    controlWsUrl: string;
    runId: string;
    agentId: string;
    groupId: string;
    apiBaseUrl: string;
    applicationId: string;
    workspaceId: string;
    restoreSession?: boolean;
    authStorage?: AuthSessionStorageKind;
    actor?: string;
    sessionId?: string;
    controlToken?: string;
    agentSessionTicket?: string;
}>;

export function runnerNewAgentLaunchSuffix(): string {
    return Date.now().toString(36).slice(-5);
}

export function controlWebSocketUrlFromHttpBaseUrl(value: string): string {
    try {
        const url = new URL(value);
        if (url.protocol === 'http:') {
            url.protocol = 'ws:';
        } else if (url.protocol === 'https:') {
            url.protocol = 'wss:';
        }
        url.pathname = '/control';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        return 'ws://localhost:5180/control';
    }
}

export function runnerAgentId(
    prefix: string,
    index: number,
    count: number,
    suffix: string,
): string {
    const safePrefix = safeIdSegment(prefix || 'agent');
    const safeSuffix = safeIdSegment(suffix || runnerNewAgentLaunchSuffix());
    return count > 1
        ? `${safePrefix}-${safeSuffix}-${index + 1}`
        : `${safePrefix}-${safeSuffix}`;
}

export function createRunnerAgentLaunchUrl(input: RunnerAgentLaunchInput): string {
    const url = new URL('/', input.origin);
    url.searchParams.set('mode', 'control');
    url.searchParams.set('workspace', 'black-box-runner');
    url.searchParams.set('tab', 'local-workbench');
    url.searchParams.set('provider', input.providerMode);
    url.searchParams.set('autoConnect', '1');
    url.searchParams.set('controlUrl', input.controlWsUrl);
    url.searchParams.set('runId', input.runId);
    url.searchParams.set('agentId', input.agentId);
    url.searchParams.set('roomId', input.groupId);
    url.searchParams.set('apiBaseUrl', input.apiBaseUrl);
    url.searchParams.set('applicationId', input.applicationId);
    url.searchParams.set('workspaceId', input.workspaceId);
    url.searchParams.set('rallarLeaveRoomOnClose', '0');
    const shouldRestoreSession = input.restoreSession === true ||
        Boolean(input.agentSessionTicket);
    if (shouldRestoreSession) {
        url.searchParams.set('rallarRestoreSession', '1');
    }
    if (input.authStorage) {
        url.searchParams.set('rallarAuthStorage', input.authStorage);
    }
    if (input.actor) {
        url.searchParams.set('actor', input.actor);
    }
    if (input.sessionId && !input.agentSessionTicket) {
        url.searchParams.set('sessionId', input.sessionId);
    }
    const fragment = new URLSearchParams();
    if (input.controlToken) {
        fragment.set('controlToken', input.controlToken);
    }
    if (input.agentSessionTicket) {
        fragment.set('agentSessionTicket', input.agentSessionTicket);
    }
    if (fragment.size > 0) {
        url.hash = fragment.toString();
    }
    return url.toString();
}

export function readRunnerAgentSessionTicketFromHash(
    hash: string,
): string | undefined {
    return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
        .get('agentSessionTicket')
        ?.trim() || undefined;
}

export function readRunnerControlTokenFromHash(
    hash: string,
): string | undefined {
    return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
        .get('controlToken')
        ?.trim() || undefined;
}

function safeIdSegment(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'agent';
}
