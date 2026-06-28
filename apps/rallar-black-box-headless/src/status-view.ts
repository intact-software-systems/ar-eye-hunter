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

    const list = document.createElement('dl');
    appendRow(list, 'Agent', snapshot.bootstrap.agentId, 'data-agent-id');
    appendRow(list, 'Run', snapshot.bootstrap.runId, 'data-run-id');
    appendRow(list, 'Control', snapshot.control.state, 'data-control-state');
    appendRow(list, 'Runtime', snapshot.state.status, 'data-runtime-state');
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
