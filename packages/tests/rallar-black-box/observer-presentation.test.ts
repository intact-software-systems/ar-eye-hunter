// @vitest-environment happy-dom

import { act, createElement, type ComponentProps, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveRallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { EventStreamPanel } from '../../../apps/rallar-black-box/src/legacy/diagnostics/events/event-stream-panel.tsx';
import { RallarTracePanel } from '../../../apps/rallar-black-box/src/legacy/diagnostics/events/rallar-trace-panel.tsx';
import { ReportPanel } from '../../../apps/rallar-black-box/src/legacy/runner/advanced/report-panel.tsx';
import { RunnerAdvancedPanel } from '../../../apps/rallar-black-box/src/legacy/runner/advanced/runner-advanced-panel.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    window.localStorage?.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
});

describe('observer presentation visibility', () => {
    it('does not visit closed report histories; Show publishes current redacted contents and Hide stops visits', async () => {
        const history = observedState('first');
        await render(createElement(ReportPanel, { state: history.state, active: true }));
        expect(history.visits()).toBe(0);

        await click('Show');
        const firstReport = reportValue();
        expect(firstReport).toMatchObject({
            summary: { commands: 1, events: 1 },
            results: [{ commandId: 'command-first', value: { token: '<redacted>', publicValue: 'first' } }],
            events: [{ eventId: 'event-first', payload: { token: '<redacted>', publicValue: 'first' } }]
        });
        expect(JSON.stringify(firstReport)).not.toContain('private-secret');

        const next = observedState('current');
        await render(createElement(ReportPanel, { state: next.state, active: true }));
        expect(reportValue()).toMatchObject({ events: [{ eventId: 'event-current' }] });
        await click('Hide');
        next.reset();
        await render(createElement(ReportPanel, { state: { ...next.state }, active: true }));
        expect(next.visits()).toBe(0);
        expect(container.querySelector('textarea')).toBeNull();
        expect(next.state.events.length).toBe(1);
        expect(next.state.commandHistory.length).toBe(1);
    });

    it('suspends a shown report while inactive and restores disclosure with current history', async () => {
        const first = observedState('first');
        await render(createElement(ReportPanel, { state: first.state, active: true }));
        await click('Show');
        const current = observedState('current');
        await render(createElement(ReportPanel, { state: current.state, active: false }));
        expect(current.visits()).toBe(0);
        expect(container.querySelector('textarea')).toBeNull();
        await render(createElement(ReportPanel, { state: current.state, active: true }));
        expect(reportValue()).toMatchObject({ events: [{ eventId: 'event-current' }] });
        expect(button('Hide')).toBeDefined();
    });

    for (const [name, Panel] of [['trace', RallarTracePanel], ['event stream', EventStreamPanel]] as const) {
        it(`does not visit inactive ${name} history and restores filters/window with current events`, async () => {
            const first = observedState('first');
            await render(createElement(Panel, { state: first.state, active: false }));
            expect(first.visits()).toBe(0);
            await render(createElement(Panel, { state: first.state, active: true }));
            await select('Window', '250');
            if (name === 'trace') {
                await select('Severity', 'warning');
            }
            else {
                await click('diagnostic');
            }
            expect(container.textContent).toContain('rallar.browser.first');
            const current = observedState('current');
            await render(createElement(Panel, { state: current.state, active: false }));
            expect(current.visits()).toBe(0);
            await render(createElement(Panel, { state: current.state, active: true }));
            expect(container.textContent).toContain('rallar.browser.current');
            expect(container.textContent).not.toContain('rallar.browser.first');
            expect(labeledSelect('Window').value).toBe('250');
            if (name === 'trace') {
                expect(labeledSelect('Severity').value).toBe('warning');
                expect(container.textContent).not.toContain('private-secret');
            }
            else {
                expect(button('diagnostic').className).toContain('selected');
            }
        });
    }

    it('honors Advanced activity and surface while retaining workbench drafts and report disclosure', async () => {
        const first = observedState('first');
        const props = advancedProps(first.state);
        await render(createElement(RunnerAdvancedPanel, { ...props, active: true }));
        await click('Show');
        const editor = container.querySelector<HTMLTextAreaElement>('.workbench-panel textarea')!;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
            setter.call(editor, '{"draft":"keep me"}');
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const current = observedState('current');
        await render(createElement(RunnerAdvancedPanel, { ...props, state: current.state, active: false }));
        expect(current.visits()).toBe(0);
        await render(createElement(RunnerAdvancedPanel, { ...props, state: current.state, active: true }));
        expect(reportValue()).toMatchObject({ events: [{ eventId: 'event-current' }] });
        expect(container.querySelector<HTMLTextAreaElement>('.workbench-panel textarea')!.value).toBe('{"draft":"keep me"}');
        await click('Manual Rallar');
        const hidden = observedState('hidden');
        await render(createElement(RunnerAdvancedPanel, { ...props, state: hidden.state, active: true }));
        expect(hidden.payloadVisits()).toBe(0);
        expect(container.querySelector('.history-panel')!.textContent).toContain('command-hidden');
        await click('Local Workbench');
        expect(reportValue()).toMatchObject({ events: [{ eventId: 'event-hidden' }] });
    });
});

async function render(element: ReactElement): Promise<void> {
    await act(async () => root.render(element));
}

function button(name: string): HTMLButtonElement {
    return [...container.querySelectorAll('button')].find((entry) => entry.textContent === name)!;
}

async function click(name: string): Promise<void> {
    await act(async () => button(name).click());
}

function labeledSelect(label: string): HTMLSelectElement {
    return [...container.querySelectorAll('label')].find((entry) => entry.querySelector('span')?.textContent === label)!
        .querySelector('select')!;
}

async function select(label: string, value: string): Promise<void> {
    await act(async () => {
        const control = labeledSelect(label);
        control.value = value;
        control.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

function reportValue(): object {
    return JSON.parse(container.querySelector<HTMLTextAreaElement>('.report-output')!.value);
}

// History entries are an owned interaction port: any entry read while presentation is suppressed
// violates the zero-hidden-history contract, independently of helper or callback topology.
function observedState(value: string) {
    let visits = 0;
    let payloadVisits = 0;
    const events: RallarBlackBoxTestEvent[] = [{
        eventId: `event-${value}`,
        kind: 'diagnostic',
        topic: `rallar.browser.${value}`,
        atEpochMs: 1000,
        severity: 'warning',
        get payload() {
            payloadVisits += 1;
            return { token: 'private-secret', publicValue: value };
        }
    }];
    const results: RallarBlackBoxTestResult[] = [{
        commandId: `command-${value}`,
        kind: 'health',
        status: 'ok',
        ok: true,
        startedAtEpochMs: 1000,
        endedAtEpochMs: 1010,
        durationMs: 10,
        value: { token: 'private-secret', publicValue: value }
    }];
    const observe = <T>(entries: T[]): T[] =>
        new Proxy(entries, {
            get(target, property, receiver) {
                if (typeof property === 'string' && /^\d+$/.test(property)) {
                    visits += 1;
                }
                return Reflect.get(target, property, receiver);
            }
        });
    const state: RallarBlackBoxTestState = {
        status: 'completed',
        currentConfig: { runId: 'observer', rallar: { provider: 'simulated' }, redaction: { secretValues: ['private-secret'] } },
        commandHistory: observe(results),
        events: observe(events),
        failures: [],
        resultCache: {}
    };
    return {
        state,
        visits: () => visits,
        payloadVisits: () => payloadVisits,
        reset: () => {
            visits = 0;
        }
    };
}

function advancedProps(state: RallarBlackBoxTestState): Omit<ComponentProps<typeof RunnerAdvancedPanel>, 'active'> {
    return {
        state,
        bootstrap: resolveRallarBlackBoxBootstrapConfig('?provider=simulated', {}, ''),
        control: { state: 'idle', reconnectAttempt: 0, sentCount: 0, receivedCount: 0 },
        globalValues: { apiBaseUrl: '', applicationId: '', workspaceId: '', clientId: '', sessionId: '', roomId: '' },
        globalValuesEdited: false,
        busy: false,
        runState: 'completed',
        queueRows: [],
        onSelectCommand: () => {},
        onGlobalValueChange: () => {},
        onSurfaceChange: () => {}
    };
}
