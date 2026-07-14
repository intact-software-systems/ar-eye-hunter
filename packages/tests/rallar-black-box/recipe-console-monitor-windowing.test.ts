// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    DistributedRunAgentProgressRow,
    DistributedRunCompositeDrilldown,
    DistributedRunEventRow,
    DistributedRunMonitor,
    DistributedRunReadinessRow,
    DistributedRunRecipeProgressRow,
    DistributedRunRuntimeDiagnosticRow,
    DistributedRunTimelineItem,
} from '../../../packages/shared-test/rallar-bb-test/distributed-run-monitor.ts';
import { MonitorAgentPhaseMatrix } from
    '../../../apps/rallar-black-box/src/recipe-console/monitor/MonitorAgentPhaseMatrix.tsx';
import { MonitorDiagnostics } from
    '../../../apps/rallar-black-box/src/recipe-console/monitor/MonitorDiagnostics.tsx';
import { MonitorEvidenceDisclosure } from
    '../../../apps/rallar-black-box/src/recipe-console/monitor/MonitorEvidenceDisclosure.tsx';
import { MonitorFailureLedger } from
    '../../../apps/rallar-black-box/src/recipe-console/monitor/MonitorFailureLedger.tsx';
import { MonitorProgressEvidence } from
    '../../../apps/rallar-black-box/src/recipe-console/monitor/MonitorProgressEvidence.tsx';
import { MonitorWindowTruth } from
    '../../../apps/rallar-black-box/src/recipe-console/monitor/MonitorWindowTruth.tsx';
import type { MonitorWorkspaceModel } from
    '../../../apps/rallar-black-box/src/recipe-console/monitor/monitor-workspace-model.ts';
import { ExplicitWindowControls } from
    '../../../apps/rallar-black-box/src/recipe-console/ui/ExplicitWindowControls.tsx';
import {
    MONITOR_WINDOW_BUDGETS,
    createMonitorWindowFingerprint,
} from '../../../apps/rallar-black-box/src/recipe-console/monitor/monitor-window-contract.ts';
import { useMonitorWindow } from
    '../../../apps/rallar-black-box/src/recipe-console/monitor/use-monitor-window.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

describe('Recipe Console Monitor window contract', () => {
    it('publishes the exact section budgets', () => {
        expect(MONITOR_WINDOW_BUDGETS).toEqual({
            failures: 60,
            agents: 80,
            recipes: 60,
            readiness: 60,
            diagnostics: 50,
            timeline: 40,
            events: 40,
            composites: 40,
            commandEvidence: 16,
            failureDestinations: 40,
            diagnosticFailureLinks: 40,
        });
    });

    it('uses collision-safe context and section fingerprints with diagnostic-only filters', () => {
        const exact = createMonitorWindowFingerprint({
            contextKey: 'context\u0000,]\u202e["diagnostics',
            section: 'diagnostics',
            diagnosticSeverity: 'warning',
            transport: 'messages.rtc',
        });
        expect(JSON.parse(exact)).toEqual([
            'monitor-window-v1',
            'context\u0000,]\u202e["diagnostics',
            'diagnostics',
            'warning',
            'messages.rtc',
        ]);
        expect(createMonitorWindowFingerprint({
            contextKey: 'context-a',
            section: 'diagnostics',
            diagnosticSeverity: 'error',
        })).not.toBe(createMonitorWindowFingerprint({
            contextKey: 'context-a',
            section: 'diagnostics',
            diagnosticSeverity: 'warning',
        }));
        expect(createMonitorWindowFingerprint({
            contextKey: 'context-a',
            section: 'failures',
            diagnosticSeverity: 'error',
            transport: 'ws',
        })).toBe(createMonitorWindowFingerprint({
            contextKey: 'context-a',
            section: 'failures',
            diagnosticSeverity: 'warning',
            transport: 'http',
        }));
    });
});

describe('Recipe Console Monitor explicit windows', () => {
    let container: HTMLDivElement;
    let latestWindow: ReturnType<typeof useMonitorWindow> | undefined;
    let root: Root | undefined;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(async () => {
        if (root) await act(async () => root?.unmount());
        root = undefined;
        container.remove();
    });

    function WindowHarness({
        contextKey,
        total,
        section = 'events',
        diagnosticSeverity,
        transport,
    }: Readonly<{
        contextKey: string;
        total: number;
        section?: keyof typeof MONITOR_WINDOW_BUDGETS;
        diagnosticSeverity?: 'debug' | 'info' | 'warning' | 'error';
        transport?: 'realtime' | 'messages.rtc' | 'ws' | 'http' | 'runtime';
    }>) {
        const window = useMonitorWindow({
            contextKey,
            total,
            section,
            diagnosticSeverity,
            transport,
        });
        latestWindow = window;
        const ordinals = Array.from({
            length: window.model.endIndexExclusive - window.model.startIndex,
        }, (_, offset) => window.model.startIndex + offset);
        return createElement(Fragment, {},
            window.model.total > window.model.windowSize
                ? createElement('div', {
                    'data-monitor-window-controls': true,
                    ...window.controlsFocusProps,
                }, createElement(ExplicitWindowControls, {
                contentId: 'monitor-test-window',
                itemLabel: section,
                label: `Monitor ${section}`,
                model: window.model,
                onNext: window.next,
                onPrevious: window.previous,
                }))
                : null,
            createElement(MonitorWindowTruth, {
                itemLabel: section,
                label: `Monitor ${section}`,
                window,
            }),
            createElement('ol', {
                id: 'monitor-test-window',
                ...window.contentFocusProps,
            }, ordinals.map(ordinal => createElement('li', {
                'data-window-ordinal': ordinal,
                key: ordinal,
            }, createElement('button', { type: 'button' }, `Row ${ordinal}`))),
            ),
        );
    }

    async function renderHarness(props: Parameters<typeof WindowHarness>[0]) {
        if (!root) root = createRoot(container);
        await act(async () => root?.render(createElement(WindowHarness, props)));
    }

    function nextButton(): HTMLButtonElement | undefined {
        return [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find(button => button.textContent === 'Next');
    }

    it('traverses first, middle, and final ranges without gaps or duplicates', async () => {
        await renderHarness({ contextKey: 'context-a', total: 137 });
        const visited: number[] = [];
        while (true) {
            visited.push(...[...container.querySelectorAll<HTMLElement>(
                '[data-window-ordinal]',
            )].map(row => Number(row.dataset.windowOrdinal)));
            const next = nextButton();
            if (!next || next.disabled) break;
            await act(async () => next.click());
        }

        expect(visited).toEqual(Array.from({ length: 137 }, (_, index) => index));
        expect(new Set(visited).size).toBe(137);
        expect(container.querySelector('[role="status"]')?.textContent)
            .toBe('Showing 121–137 of 137 events.');
        expect(container.querySelector('[data-monitor-window-outside]')?.textContent)
            .toBe('120 events outside this render window and browseable.');
    });

    it('retains same-context movement, clamps mutation shrink, and resets a changed context',
        async () => {
            await renderHarness({ contextKey: 'context-a', total: 137 });
            await act(async () => nextButton()?.click());
            await act(async () => nextButton()?.click());
            expect(container.querySelector('[role="status"]')?.textContent)
                .toBe('Showing 81–120 of 137 events.');

            await renderHarness({ contextKey: 'context-a', total: 83 });
            expect(container.querySelector('[role="status"]')?.textContent)
                .toBe('Showing 81–83 of 83 events.');

            await renderHarness({ contextKey: 'context-b', total: 83 });
            expect(container.querySelector('[role="status"]')?.textContent)
                .toBe('Showing 1–40 of 83 events.');
        });

    it('resets diagnostics for severity or transport but ignores those filters elsewhere',
        async () => {
            await renderHarness({
                contextKey: 'context-a', total: 130, section: 'diagnostics',
            });
            await act(async () => nextButton()?.click());
            expect(container.querySelector('[role="status"]')?.textContent)
                .toBe('Showing 51–100 of 130 diagnostics.');
            await renderHarness({
                contextKey: 'context-a', total: 130, section: 'diagnostics',
                diagnosticSeverity: 'warning', transport: 'ws',
            });
            expect(container.querySelector('[role="status"]')?.textContent)
                .toBe('Showing 1–50 of 130 diagnostics.');

            await renderHarness({
                contextKey: 'context-a', total: 130, section: 'failures',
                diagnosticSeverity: 'warning', transport: 'ws',
            });
            await act(async () => nextButton()?.click());
            await renderHarness({
                contextKey: 'context-a', total: 130, section: 'failures',
                diagnosticSeverity: 'error', transport: 'http',
            });
            expect(container.querySelector('[role="status"]')?.textContent)
                .toBe('Showing 61–120 of 130 failures.');
        });

    it('recovers focused row content to the stable range after traversal', async () => {
        await renderHarness({ contextKey: 'context-a', total: 90 });
        expect(latestWindow?.focusFallbackRef.current).toBe(
            container.querySelector('[data-monitor-window-focus-anchor]'),
        );
        const next = nextButton();
        next?.focus();
        await act(async () => next?.click());
        const row = container.querySelector<HTMLButtonElement>(
            '[data-window-ordinal="40"] button',
        );
        row?.focus();
        expect(document.activeElement).toBe(row);
        await renderHarness({ contextKey: 'context-a', total: 83 });
        expect(document.activeElement).toBe(row);
        await renderHarness({ contextKey: 'context-b', total: 90 });
        expect(document.activeElement).toBe(
            container.querySelector('[data-monitor-window-focus-anchor]'),
        );
    });

    it('windows failures without changing selection or action authority', async () => {
        const exactLateId = 'failure/late\u202e/\u754c/' + 'x'.repeat(160);
        const failures = Array.from({ length: 121 }, (_, index) => ({
            kind: 'command' as const,
            key: index === 120 ? exactLateId : `failure-${index % 2}`,
            message: `Failure ${index}`,
            agentId: index === 120 ? exactLateId : `agent-${index % 3}`,
            commandId: `command-${index}`,
        }));
        const onInspect = vi.fn();
        const onNavigate = vi.fn();
        const onRefresh = vi.fn();
        const onDestructiveAction = vi.fn();
        root = createRoot(container);
        await act(async () => root?.render(createElement(MonitorFailureLedger, {
            contextKey: 'context-a',
            failures,
            onInspect,
            selected: { kind: 'failure', id: exactLateId },
        })));

        expect(container.querySelectorAll('[data-failure-key]')).toHaveLength(60);
        expect(container.querySelector('[aria-pressed="true"]')).toBeNull();
        await act(async () => windowButton(container, 'Next')?.click());
        await act(async () => windowButton(container, 'Next')?.click());
        expect(container.querySelectorAll('[data-failure-key]')).toHaveLength(1);
        const selected = container.querySelector<HTMLButtonElement>(
            '[data-failure-key][aria-pressed="true"]',
        );
        expect(selected?.dataset.failureKey).toBe(exactLateId);
        expect(selected?.textContent).toContain(exactLateId);
        expect(selected?.querySelector('bdi[data-exact-identifier]')?.getAttribute('dir'))
            .toBe('ltr');
        expect([onInspect, onNavigate, onRefresh, onDestructiveAction].map(
            callback => callback.mock.calls.length,
        )).toEqual([0, 0, 0, 0]);
        expect(failures.map(row => row.message)).toEqual(
            Array.from({ length: 121 }, (_, index) => `Failure ${index}`),
        );
    });

    it.each(['later content row', 'window control'] as const)(
        'recovers a focused %s when a same-context poll drops below the failure budget',
        async (focusedTarget) => {
            const onInspect = vi.fn();
            const failures = (count: number) => Array.from(
                { length: count },
                (_, index) => ({
                    kind: 'command' as const,
                    key: `poll-failure-${index}`,
                    message: `Poll failure ${index}`,
                    commandId: `poll-command-${index}`,
                }),
            );
            const renderLedger = async (count: number) => {
                if (!root) root = createRoot(container);
                await act(async () => root?.render(createElement(MonitorFailureLedger, {
                    contextKey: 'poll-context-a',
                    failures: failures(count),
                    onInspect,
                })));
            };

            await renderLedger(121);
            await act(async () => windowButton(container, 'Next')?.click());
            expect(container.querySelector('[role="status"]')?.textContent)
                .toBe('Showing 61–120 of 121 failures.');
            const target = focusedTarget === 'later content row'
                ? container.querySelector<HTMLButtonElement>(
                    '[data-monitor-source-ordinal="60"] button',
                )
                : windowButton(container, 'Previous');
            target?.focus();
            expect(document.activeElement).toBe(target);

            await renderLedger(30);
            const anchor = container.querySelector<HTMLElement>(
                '[data-monitor-window-focus-anchor="Failures"]',
            );
            expect(document.activeElement).toBe(anchor);
            expect(anchor?.textContent).toContain('Showing 1–30 of 30 failures');
            expect(container.querySelector('[aria-label="Failures window"]')).toBeNull();
            expect(container.querySelector('[data-monitor-window-outside]')).toBeNull();
            expect(container.querySelectorAll('[data-failure-key]')).toHaveLength(30);
            expect([...container.querySelectorAll<HTMLElement>(
                '[data-monitor-source-ordinal]',
            )].map(row => Number(row.dataset.monitorSourceOrdinal))).toEqual(
                Array.from({ length: 30 }, (_, index) => index),
            );
            expect(container.querySelectorAll('[aria-live]')).toHaveLength(0);
            expect(onInspect).not.toHaveBeenCalled();
        },
    );

    it('recovers focused Next when the first failure window shrinks from 61 to 60',
        async () => {
            const failures = (count: number) => Array.from(
                { length: count },
                (_, index) => ({
                    kind: 'command' as const,
                    key: `threshold-failure-${index}`,
                    message: `Threshold failure ${index}`,
                    commandId: `threshold-command-${index}`,
                }),
            );
            const renderLedger = async (count: number) => {
                if (!root) root = createRoot(container);
                await act(async () => root?.render(createElement(MonitorFailureLedger, {
                    contextKey: 'threshold-context-a',
                    failures: failures(count),
                    onInspect: vi.fn(),
                })));
            };

            await renderLedger(61);
            const next = windowButton(container, 'Next');
            next?.focus();
            expect(document.activeElement).toBe(next);

            await renderLedger(60);
            const anchor = container.querySelector<HTMLElement>(
                '[data-monitor-window-focus-anchor="Failures"]',
            );
            expect(document.activeElement).toBe(anchor);
            expect(anchor?.textContent).toContain('Showing 1–60 of 60 failures');
            expect(container.querySelector('[aria-label="Failures window"]')).toBeNull();
            expect(container.querySelectorAll('[data-failure-key]')).toHaveLength(60);
        });

    it('mounts exact agent, recipe, readiness, and diagnostic budgets with ordinal keys',
        async () => {
            const exactId = 'agent/late\u202e/\u754c/' + 'x'.repeat(120);
            const agents = Array.from({ length: 85 }, (_, index) => agentRow(
                index,
                index === 0 ? exactId : `agent-${index % 2}`,
            ));
            const recipes = Array.from({ length: 65 }, (_, index) =>
                recipeRow(index, index === 0 ? exactId : `recipe-${index % 2}`));
            const readiness = Array.from({ length: 65 }, (_, index) =>
                readinessRow(index, index === 0 ? exactId : `agent-${index % 2}`));
            const diagnostics = Array.from({ length: 55 }, (_, index) =>
                diagnosticRow(index, index === 0 ? exactId : `agent-${index % 2}`));
            const onInspect = vi.fn();
            const onFilter = vi.fn();
            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            root = createRoot(container);
            await act(async () => root?.render(createElement(Fragment, {},
                createElement(MonitorAgentPhaseMatrix, {
                    contextKey: 'context-a', onInspect, rows: agents,
                    selected: { kind: 'agent', id: exactId },
                }),
                createElement(MonitorProgressEvidence, {
                    contextKey: 'context-a', onInspect, readiness, recipes,
                    selected: { kind: 'agent', id: exactId },
                }),
                createElement(MonitorDiagnostics, {
                    model: monitorModel({ runtimeDiagnostics: diagnostics }),
                    onFilter, onInspect,
                    selected: { kind: 'diagnostic', id: diagnostics[54]!.eventId },
                }),
            )));

            expect(container.querySelectorAll('[data-monitor-agent-row]')).toHaveLength(80);
            expect(container.querySelectorAll('[data-monitor-recipe-row]')).toHaveLength(60);
            expect(container.querySelectorAll('[data-monitor-readiness-row]')).toHaveLength(60);
            expect(container.querySelectorAll('[data-monitor-diagnostic-row]')).toHaveLength(50);
            expect(container.querySelectorAll('bdi[data-exact-identifier]')).not.toHaveLength(0);
            expect(container.textContent).toContain(exactId);
            expect(container.querySelector(
                '[data-monitor-readiness-row] button[aria-pressed="true"]',
            )).not.toBeNull();
            const matrix = container.querySelector('[data-monitor-section="matrix"]');
            const matrixControls = matrix?.querySelector('[aria-label="Agents window"]');
            const matrixScroller = matrix?.querySelector('[data-monitor-matrix-scroller]');
            expect(matrixControls).not.toBeNull();
            expect(matrixScroller?.contains(matrixControls ?? null)).toBe(false);
            expect(matrixControls?.compareDocumentPosition(matrixScroller ?? matrixControls) ?? 0)
                .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
            expect(consoleError.mock.calls.flat().join('\n')).not.toContain(
                'same key',
            );
            expect(onInspect).not.toHaveBeenCalled();
            expect(onFilter).not.toHaveBeenCalled();
            consoleError.mockRestore();
        });

    it('resets only the diagnostics cursor when its active filters change', async () => {
        const diagnostics = Array.from({ length: 120 }, (_, index) => ({
            ...diagnosticRow(index),
            severity: index < 60 ? 'warning' as const : 'error' as const,
        }));
        const onInspect = vi.fn();
        const onFilter = vi.fn();
        async function renderDiagnostics(severity?: 'warning' | 'error') {
            if (!root) root = createRoot(container);
            await act(async () => root?.render(createElement(MonitorDiagnostics, {
                model: monitorModel({ runtimeDiagnostics: diagnostics }),
                onFilter,
                onInspect,
                severity,
            })));
        }

        await renderDiagnostics();
        await act(async () => windowButton(container, 'Next')?.click());
        expect(container.querySelector('[role="status"]')?.textContent)
            .toBe('Showing 51–100 of 120 diagnostics.');
        await renderDiagnostics('warning');
        expect(container.querySelector('[role="status"]')?.textContent)
            .toBe('Showing 1–50 of 60 diagnostics.');
        expect(onInspect).not.toHaveBeenCalled();
        expect(onFilter).not.toHaveBeenCalled();
    });

    it('keeps disclosure cursors alive while closed and mounts no closed rows', async () => {
        const events = Array.from({ length: 85 }, (_, index) => ({
            ...eventRow(index),
            ...(index === 84 ? { eventId: 'event-late-exact' } : {}),
        }));
        const model = monitorModel({
            timeline: Array.from({ length: 85 }, (_, index) => timelineRow(index)),
            events,
            compositeDrilldowns: Array.from(
                { length: 85 },
                (_, index) => compositeRow(index),
            ),
        });
        const onInspect = vi.fn();
        root = createRoot(container);
        await act(async () => root?.render(createElement(MonitorEvidenceDisclosure, {
            model,
            onInspect,
            selected: { kind: 'event', id: events[84]!.eventId },
        })));

        expect(container.querySelectorAll('[data-monitor-disclosure-row]')).toHaveLength(0);
        expect(container.querySelectorAll('[data-monitor-window-controls]')).toHaveLength(0);
        const eventDetails = detailsBySummary(container, 'Events (85)');
        const timelineDetails = detailsBySummary(container, 'Timeline (85)');
        await toggleDetails(eventDetails, true);
        expect(container.querySelectorAll('[data-monitor-event-row]')).toHaveLength(40);
        expect(container.querySelector('[aria-label="Events window"]')).not.toBeNull();
        await act(async () => windowButton(eventDetails, 'Next')?.click());
        expect(eventDetails.querySelector('[role="status"]')?.textContent)
            .toBe('Showing 41–80 of 85 events.');
        await toggleDetails(eventDetails, false);
        expect(container.querySelectorAll('[data-monitor-event-row]')).toHaveLength(0);
        expect(eventDetails.querySelector('[role="status"]')).toBeNull();

        await toggleDetails(timelineDetails, true);
        expect(container.querySelectorAll('[data-monitor-timeline-row]')).toHaveLength(40);
        expect(timelineDetails.querySelector('[role="status"]')?.textContent)
            .toBe('Showing 1–40 of 85 timeline rows.');
        await toggleDetails(eventDetails, true);
        expect(eventDetails.querySelector('[role="status"]')?.textContent)
            .toBe('Showing 41–80 of 85 events.');
        expect(timelineDetails.open).toBe(true);

        await act(async () => windowButton(eventDetails, 'Next')?.click());
        const selected = eventDetails.querySelector<HTMLButtonElement>(
            '[data-monitor-event-row][aria-pressed="true"]',
        );
        expect(selected?.textContent).toContain(events[84]!.summary);
        expect(onInspect).not.toHaveBeenCalled();
    });
});

function windowButton(
    container: HTMLElement,
    label: 'Previous' | 'Next',
): HTMLButtonElement | undefined {
    return [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent === label);
}

function agentRow(index: number, agentId = `agent-${index}`): DistributedRunAgentProgressRow {
    return {
        agentId,
        role: `role-${index}`,
        readiness: 'ready',
        barrier: 'passed',
        execution: 'running',
        stageCommandCount: 1,
        barrierCommandCount: 1,
        startCommandCount: 1,
        completedCommandCount: index,
        failedCommandCount: 0,
        resultCount: index,
        eventCount: index,
    };
}

function recipeRow(index: number, recipeId = `recipe-${index}`): DistributedRunRecipeProgressRow {
    return {
        recipeId,
        role: `role-${index % 2}`,
        required: true,
        targetCount: 1,
        queuedCount: 0,
        runningCount: 0,
        passedCount: 1,
        failedCount: 0,
        missingCount: 0,
    };
}

function readinessRow(index: number, agentId = `agent-${index}`): DistributedRunReadinessRow {
    return {
        agentId,
        role: `role-${index % 2}`,
        status: 'ready',
        commandId: index === 0 ? undefined : `command-${index}`,
        completedAtEpochMs: index + 1,
    };
}

function diagnosticRow(
    index: number,
    agentId = `agent-${index}`,
): DistributedRunRuntimeDiagnosticRow {
    return {
        eventId: `diagnostic-${index % 2}`,
        atEpochMs: index + 1,
        severity: 'warning',
        agentId,
        commandId: `command-${index}`,
        transport: 'ws',
        topic: 'runtime',
        diagnosticTypeId: 'runtime-warning',
        message: `Diagnostic ${index}`,
        summary: `Diagnostic ${index}`,
        payloadSummary: '{}',
        correlatedFailureKeys: [],
    };
}

function timelineRow(index: number): DistributedRunTimelineItem {
    return {
        id: `timeline-${index % 2}`,
        atEpochMs: index + 1,
        kind: 'event',
        label: `Timeline ${index}`,
        tone: 'partial',
        agentId: `agent-${index}`,
    };
}

function eventRow(index: number): DistributedRunEventRow {
    return {
        eventId: `event-${index % 2}`,
        atEpochMs: index + 1,
        kind: 'runtime',
        agentId: `agent-${index}`,
        summary: `Event ${index}`,
        payloadSummary: '{}',
    };
}

function compositeRow(index: number): DistributedRunCompositeDrilldown {
    return {
        key: `composite-${index % 2}`,
        commandId: `command-${index % 2}`,
        agentId: `agent-${index}`,
        artifactRef: `artifact-${index}`,
        summary: {
            total: 1,
            passed: 1,
            failed: 0,
            byKind: {},
        },
        groupSummaries: [],
        rows: [],
    };
}

function monitorModel(
    patch: Partial<DistributedRunMonitor>,
    contextKey = 'context-a',
): MonitorWorkspaceModel {
    return {
        source: { contextKey },
        monitor: {
            artifact: { status: 'available' },
            timeline: [],
            agentProgress: [],
            recipeProgress: [],
            readiness: [],
            failures: [],
            events: [],
            runtimeDiagnostics: [],
            compositeDrilldowns: [],
            diagnosticCounts: {
                total: patch.runtimeDiagnostics?.length ?? 0,
                info: 0,
                warning: patch.runtimeDiagnostics?.filter(
                    row => row.severity === 'warning'
                ).length ?? 0,
                error: patch.runtimeDiagnostics?.filter(
                    row => row.severity === 'error'
                ).length ?? 0,
                ws: patch.runtimeDiagnostics?.filter(
                    row => row.transport === 'ws'
                ).length ?? 0,
                rtc: 0,
                http: 0,
                runtime: 0,
            },
            ...patch,
        },
    } as unknown as MonitorWorkspaceModel;
}

function detailsBySummary(container: HTMLElement, label: string): HTMLDetailsElement {
    const details = [...container.querySelectorAll<HTMLDetailsElement>('details')]
        .find(candidate => candidate.querySelector('summary')?.textContent === label);
    if (!details) throw new Error(`Missing disclosure: ${label}`);
    return details;
}

async function toggleDetails(details: HTMLDetailsElement, open: boolean): Promise<void> {
    await act(async () => {
        details.open = open;
        details.dispatchEvent(new Event('toggle'));
    });
}
