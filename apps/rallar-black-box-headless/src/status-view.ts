import type { RallarBlackBoxBrowserControlAgentSnapshot } from '@shared-test/rallar-bb-test/browser-control-agent.ts';

function text(value: unknown): string {
    return value === undefined || value === null || value === '' ? '-' : String(value);
}

function appendText(
    parent: HTMLElement,
    tagName: 'h1' | 'p',
    value: unknown,
    attr?: string,
): HTMLElement {
    const element = document.createElement(tagName);
    element.textContent = text(value);
    if (attr) {
        element.setAttribute(attr, '');
    }
    parent.append(element);
    return element;
}

function appendRow(
    list: HTMLDListElement,
    label: string,
    value: unknown,
    attr: string,
): void {
    const term = document.createElement('dt');
    term.textContent = label;

    const details = document.createElement('dd');
    details.textContent = text(value);
    details.setAttribute(attr, '');

    list.append(term, details);
}

export function renderHeadlessStatus(
    root: HTMLElement,
    snapshot: RallarBlackBoxBrowserControlAgentSnapshot,
): void {
    const latestCommand = snapshot.state.commandHistory.at(-1);
    const latestEvent = snapshot.state.events.at(-1);
    const identity = snapshot.control.identity;
    const applicationId = identity?.applicationId ?? snapshot.bootstrap.applicationId;
    const workspaceId = identity?.workspaceId ?? snapshot.bootstrap.workspaceId;
    const groupId = identity?.groupId ?? snapshot.bootstrap.roomId;
    const region = identity?.region ?? snapshot.bootstrap.fleetRegion;
    const provider = identity?.provider ?? snapshot.bootstrap.fleetProvider;

    root.replaceChildren();

    const section = document.createElement('section');
    section.className = 'agent-shell';
    section.setAttribute('aria-label', 'Headless agent status');

    const header = document.createElement('header');
    appendText(header, 'h1', 'Rallar Black Box Headless Agent');
    appendText(header, 'p', snapshot.lastAction, 'data-last-action');
    section.append(header);

    if (snapshot.lastError) {
        const error = appendText(section, 'p', snapshot.lastError, 'data-last-error');
        error.className = 'error';
    }
    if (!applicationId || !workspaceId || !groupId || !region || !provider) {
        const warning = appendText(
            section,
            'p',
            'Missing global fleet identity; this browser may not be targetable by world-fleet recipes.',
            'data-fleet-identity-warning',
        );
        warning.className = 'warning';
    }

    const list = document.createElement('dl');
    appendRow(list, 'Agent', snapshot.bootstrap.agentId, 'data-agent-id');
    appendRow(list, 'Run', snapshot.bootstrap.runId, 'data-run-id');
    appendRow(list, 'Control', snapshot.control.state, 'data-control-state');
    appendRow(list, 'Runtime', snapshot.state.status, 'data-runtime-state');
    appendRow(list, 'Application', applicationId, 'data-application-id');
    appendRow(list, 'Workspace', workspaceId, 'data-workspace-id');
    appendRow(list, 'Group', groupId, 'data-group-id');
    appendRow(list, 'Principal', identity?.principalId ?? snapshot.bootstrap.actor, 'data-principal-id');
    appendRow(list, 'Client', identity?.clientId ?? snapshot.bootstrap.actor, 'data-client-id');
    appendRow(list, 'Session', identity?.sessionId ?? snapshot.bootstrap.sessionId, 'data-session-id');
    appendRow(list, 'Region', region, 'data-fleet-region');
    appendRow(list, 'Fleet provider', provider, 'data-fleet-provider');
    appendRow(list, 'Datacenter', identity?.datacenter ?? snapshot.bootstrap.fleetDatacenter, 'data-fleet-datacenter');
    appendRow(list, 'Host', identity?.hostId ?? snapshot.bootstrap.fleetHostId, 'data-fleet-host');
    appendRow(list, 'Last heartbeat', snapshot.control.lastHeartbeatAtEpochMs, 'data-last-heartbeat');
    appendRow(list, 'Reconnect count', snapshot.control.reconnectAttempt, 'data-reconnect-count');
    appendRow(list, 'Provider', snapshot.bootstrap.providerMode, 'data-provider');
    appendRow(list, 'Transport', snapshot.bootstrap.transport, 'data-transport');
    appendRow(list, 'Room', snapshot.bootstrap.roomId, 'data-room-id');
    appendRow(list, 'Sent', snapshot.control.sentCount, 'data-sent-count');
    appendRow(list, 'Received', snapshot.control.receivedCount, 'data-received-count');
    appendRow(list, 'Latest command', latestCommand?.commandId, 'data-latest-command-id');
    appendRow(list, 'Latest event', latestEvent?.topic, 'data-latest-event-topic');
    section.append(list);

    root.append(section);
}
