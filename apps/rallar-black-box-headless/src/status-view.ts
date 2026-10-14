import type { RallarBlackBoxBrowserControlAgentSnapshot } from '@shared-test/rallar-bb-test/browser-control-agent.ts';
import { PacedEmit } from '@shared-test/rallar-bb-test/browser-control-agent/paced-emit.ts';

type HeadlessStatusValue = string | number | undefined;

const STATUS_RENDER_INTERVAL_MS = 100;
const FLEET_IDENTITY_WARNING =
    'Missing global fleet identity; this browser may not be targetable by world-fleet recipes.';
const STATUS_ROWS = [
    { label: 'Agent', attribute: 'data-agent-id' },
    { label: 'Run', attribute: 'data-run-id' },
    { label: 'Control', attribute: 'data-control-state' },
    { label: 'Runtime', attribute: 'data-runtime-state' },
    { label: 'Application', attribute: 'data-application-id' },
    { label: 'Workspace', attribute: 'data-workspace-id' },
    { label: 'Group', attribute: 'data-group-id' },
    { label: 'Principal', attribute: 'data-principal-id' },
    { label: 'Client', attribute: 'data-client-id' },
    { label: 'Session', attribute: 'data-session-id' },
    { label: 'Region', attribute: 'data-fleet-region' },
    { label: 'Fleet provider', attribute: 'data-fleet-provider' },
    { label: 'Datacenter', attribute: 'data-fleet-datacenter' },
    { label: 'Host', attribute: 'data-fleet-host' },
    { label: 'Last heartbeat', attribute: 'data-last-heartbeat' },
    { label: 'Reconnect count', attribute: 'data-reconnect-count' },
    { label: 'Provider', attribute: 'data-provider' },
    { label: 'Transport', attribute: 'data-transport' },
    { label: 'Room', attribute: 'data-room-id' },
    { label: 'Sent', attribute: 'data-sent-count' },
    { label: 'Received', attribute: 'data-received-count' },
    { label: 'Latest command', attribute: 'data-latest-command-id' },
    { label: 'Latest event', attribute: 'data-latest-event-topic' }
] as const;

type HeadlessStatusRowAttribute = typeof STATUS_ROWS[number]['attribute'];

export class HeadlessStatusView {
    private readonly readSnapshot: () => RallarBlackBoxBrowserControlAgentSnapshot;
    private readonly pacedRender = new PacedEmit(STATUS_RENDER_INTERVAL_MS, () => this.render());
    private readonly header = document.createElement('header');
    private readonly list = document.createElement('dl');
    private readonly lastAction: HTMLElement;
    private readonly lastError: HTMLElement;
    private readonly fleetIdentityWarning: HTMLElement;
    private readonly rowValues = new Map<HeadlessStatusRowAttribute, HTMLElement>();

    constructor(root: HTMLElement, readSnapshot: () => RallarBlackBoxBrowserControlAgentSnapshot) {
        this.readSnapshot = readSnapshot;
        const section = document.createElement('section');
        section.className = 'agent-shell';
        section.setAttribute('aria-label', 'Headless agent status');

        this.lastAction = toTextElement('p', '-', 'data-last-action');
        this.header.append(toTextElement('h1', 'Rallar Black Box Headless Agent'), this.lastAction);
        this.lastError = toTextElement('p', '-', 'data-last-error');
        this.lastError.className = 'error';
        this.fleetIdentityWarning = toTextElement('p', FLEET_IDENTITY_WARNING, 'data-fleet-identity-warning');
        this.fleetIdentityWarning.className = 'warning';

        for (const row of STATUS_ROWS) {
            const term = document.createElement('dt');
            term.textContent = row.label;
            const value = toTextElement('dd', '-', row.attribute);
            this.rowValues.set(row.attribute, value);
            this.list.append(term, value);
        }
        section.append(this.header, this.list);
        root.replaceChildren(section);
    }

    requestRender(): void {
        this.pacedRender.request();
    }

    render(): void {
        const snapshot = this.readSnapshot();
        setText(this.lastAction, snapshot.lastAction);
        setText(this.lastError, snapshot.lastError);
        const values = toStatusRowValues(snapshot);
        for (const [attribute, value] of this.rowValues) {
            setText(value, values[attribute]);
        }
        showLine(this.lastError, Boolean(snapshot.lastError), () => this.header.after(this.lastError));
        showLine(
            this.fleetIdentityWarning,
            !hasFleetIdentity(values),
            () => this.list.before(this.fleetIdentityWarning)
        );
    }
}

function toStatusRowValues(
    snapshot: RallarBlackBoxBrowserControlAgentSnapshot
): Readonly<Record<HeadlessStatusRowAttribute, HeadlessStatusValue>> {
    const { bootstrap, control, state } = snapshot;
    const identity = control.identity;
    return {
        'data-agent-id': bootstrap.agentId,
        'data-run-id': bootstrap.runId,
        'data-control-state': control.state,
        'data-runtime-state': state.status,
        'data-application-id': identity?.applicationId ?? bootstrap.applicationId,
        'data-workspace-id': identity?.workspaceId ?? bootstrap.workspaceId,
        'data-group-id': identity?.groupId ?? bootstrap.roomId,
        'data-principal-id': identity?.principalId ?? bootstrap.actor,
        'data-client-id': identity?.clientId ?? bootstrap.actor,
        'data-session-id': identity?.sessionId ?? bootstrap.sessionId,
        'data-fleet-region': identity?.region ?? bootstrap.fleetRegion,
        'data-fleet-provider': identity?.provider ?? bootstrap.fleetProvider,
        'data-fleet-datacenter': identity?.datacenter ?? bootstrap.fleetDatacenter,
        'data-fleet-host': identity?.hostId ?? bootstrap.fleetHostId,
        'data-last-heartbeat': control.lastHeartbeatAtEpochMs,
        'data-reconnect-count': control.reconnectAttempt,
        'data-provider': bootstrap.providerMode,
        'data-transport': bootstrap.transport,
        'data-room-id': bootstrap.roomId,
        'data-sent-count': control.sentCount,
        'data-received-count': control.receivedCount,
        'data-latest-command-id': state.commandHistory.at(-1)?.commandId,
        'data-latest-event-topic': state.events.at(-1)?.topic
    };
}

function hasFleetIdentity(values: Readonly<Record<HeadlessStatusRowAttribute, HeadlessStatusValue>>): boolean {
    return [
        values['data-application-id'],
        values['data-workspace-id'],
        values['data-group-id'],
        values['data-fleet-region'],
        values['data-fleet-provider']
    ].every(Boolean);
}

function toText(value: HeadlessStatusValue): string {
    return value === undefined || value === '' ? '-' : String(value);
}

function toTextElement(tagName: 'h1' | 'p' | 'dd', value: string, attribute?: string): HTMLElement {
    const element = document.createElement(tagName);
    element.textContent = value;
    if (attribute) {
        element.setAttribute(attribute, '');
    }
    return element;
}

function setText(element: HTMLElement, value: HeadlessStatusValue): void {
    const text = toText(value);
    if (element.textContent !== text) {
        element.textContent = text;
    }
}

/** The error and the fleet warning sit between the header and the list only while they apply. */
function showLine(line: HTMLElement, shown: boolean, insert: () => void): void {
    if (!shown) {
        line.remove();
    }
    else if (line.parentElement === null) {
        insert();
    }
}
