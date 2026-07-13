// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitorInspector } from
    '../../../apps/rallar-black-box/src/recipe-console/monitor/MonitorInspector.tsx';
import type { MonitorWorkspaceModel } from
    '../../../apps/rallar-black-box/src/recipe-console/monitor/monitor-workspace-model.ts';
import {
    createMonitorRecipeEvidenceSelectionId,
    type MonitorEvidenceSelection,
} from '../../../apps/rallar-black-box/src/recipe-console/monitor/monitor-selection.ts';
import type {
    DistributedRunEventRow,
    DistributedRunFailureRow,
    DistributedRunRecipeProgressRow,
    DistributedRunRuntimeDiagnosticRow,
    DistributedRunTimelineItem,
} from '../../../packages/shared-test/rallar-bb-test/distributed-run-monitor.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

type ModelCollections = Readonly<{
    contextKey?: string;
    failures?: readonly DistributedRunFailureRow[];
    diagnostics?: readonly DistributedRunRuntimeDiagnosticRow[];
    timeline?: readonly DistributedRunTimelineItem[];
    events?: readonly DistributedRunEventRow[];
    recipes?: readonly DistributedRunRecipeProgressRow[];
}>;

describe('Recipe Console Monitor inspector windows', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    async function render(
        model: MonitorWorkspaceModel,
        selection: MonitorEvidenceSelection,
        onSelectEvidence = vi.fn(),
    ) {
        await act(async () => root.render(createElement(MonitorInspector, {
            legacyHref: '/?tab=runs',
            model,
            onSelectEvidence,
            selection,
        })));
        return onSelectEvidence;
    }

    it('browses command evidence failure-first in 16-row windows and activates the exact late item',
        async () => {
            const commandId = 'command::\u2067late\u2069';
            const failures = Array.from({ length: 2 }, (_, index) =>
                failure(`failure-${index}`, commandId));
            const diagnostics = Array.from({ length: 2 }, (_, index) =>
                diagnostic(`diagnostic-${index}`, commandId));
            const timeline = Array.from({ length: 2 }, (_, index) =>
                timelineItem(`timeline-${index}`, commandId));
            const events = Array.from({ length: 14 }, (_, index) =>
                event(index === 13 ? 'event::last\u2067|\u2069' : `event-${index}`, commandId));
            const onSelect = await render(model({ failures, diagnostics, timeline, events }), {
                kind: 'command', id: commandId,
            });

            expect(windowStatus('Command evidence')?.textContent)
                .toBe('Showing 1–16 of 20 linked items.');
            expect(windowButtons('monitor-inspector-command-evidence')).toHaveLength(16);
            expect(windowButtons('monitor-inspector-command-evidence')[0]?.textContent)
                .toContain('failure-0');
            expect(container.textContent).toContain('Events14');

            const next = controlButton('Command evidence', 'Next');
            next.focus();
            await act(async () => next.click());
            expect(document.activeElement).toBe(next);
            expect(windowStatus('Command evidence')?.textContent)
                .toBe('Showing 17–20 of 20 linked items.');
            expect(windowButtons('monitor-inspector-command-evidence')).toHaveLength(4);

            const late = windowButtons('monitor-inspector-command-evidence')
                .find(button => button.textContent?.includes('event::last\u2067|\u2069'));
            expect(late).toBeDefined();
            const exactId = late?.querySelector<HTMLElement>('[data-exact-identifier]');
            expect(exactId?.getAttribute('dir')).toBe('ltr');
            expect(exactId?.querySelector('code')?.textContent)
                .toBe('event::last\u2067|\u2069');
            await act(async () => late?.click());
            expect(onSelect).toHaveBeenLastCalledWith({
                kind: 'event', id: 'event::last\u2067|\u2069',
            });

            late?.focus();
            const nextCommandId = 'command::next';
            await render(model({
                events: Array.from({ length: 20 }, (_, index) =>
                    event(`next-command-event-${index}`, nextCommandId)),
            }), { kind: 'command', id: nextCommandId }, onSelect);
            expect(document.activeElement).toBe(container.querySelector(
                '[data-monitor-window-focus-anchor="Command evidence"]',
            ));
            expect(windowStatus('Command evidence')?.textContent)
                .toBe('Showing 1–16 of 20 linked items.');
            expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
        });

    it('windows 46 correlated failure destinations at 40 and preserves destination patches',
        async () => {
            const commandId = 'command/failure';
            const selected = failure('failure::\u2067selected\u2069', commandId);
            const diagnostics = Array.from({ length: 45 }, (_, index) => diagnostic(
                index === 44 ? 'diagnostic::last|\u2067x\u2069' : `diagnostic-${index}`,
                commandId,
                [selected.key],
            ));
            const onSelect = await render(model({ failures: [selected], diagnostics }), {
                kind: 'failure', id: selected.key,
            });

            expect(container.querySelector('[data-evidence-destination="command"]')
                ?.getAttribute('data-evidence-id')).toBe(commandId);
            expect(windowStatus('Failure destinations')?.textContent)
                .toBe('Showing 1–40 of 47 destinations.');
            expect(windowButtons('monitor-inspector-failure-destinations')).toHaveLength(40);

            await act(async () => controlButton('Failure destinations', 'Next').click());
            expect(windowStatus('Failure destinations')?.textContent)
                .toBe('Showing 41–47 of 47 destinations.');
            const late = container.querySelector<HTMLButtonElement>(
                '[data-evidence-id="diagnostic::last|\u2067x\u2069"]',
            );
            expect(late).not.toBeNull();
            await act(async () => late?.click());
            expect(onSelect).toHaveBeenLastCalledWith(
                { kind: 'diagnostic', id: 'diagnostic::last|\u2067x\u2069' },
                { agentId: 'agent-a', recipeId: undefined, commandId },
            );
        });

    it('resets diagnostic-link windows by exact selection, clamps polls, and drops stale evidence',
        async () => {
            const first = diagnostic('diagnostic::first', 'command-a',
                Array.from({ length: 45 }, (_, index) => `failure-first-${index}`));
            await render(model({ diagnostics: [first] }), {
                kind: 'diagnostic', id: first.eventId,
            });
            await act(async () => controlButton('Diagnostic failure links', 'Next').click());
            expect(windowStatus('Diagnostic failure links')?.textContent)
                .toBe('Showing 41–45 of 45 failure links.');

            const currentModel = model({
                diagnostics: [{ ...first, correlatedFailureKeys: ['failure-now-0', 'failure-now-1'] }],
            });
            await render(currentModel, { kind: 'diagnostic', id: first.eventId });
            expect(container.querySelector('[role="group"][aria-label="Diagnostic failure links window"]'))
                .toBeNull();
            expect(windowButtons('monitor-inspector-diagnostic-failure-links')
                .map(button => button.textContent)).toEqual([
                    'Failurefailure-now-0', 'Failurefailure-now-1',
                ]);

            const second = diagnostic('diagnostic::second\u2067|\u2069', 'command-b',
                Array.from({ length: 45 }, (_, index) => `failure-second-${index}`));
            await render(model({ diagnostics: [second] }), {
                kind: 'diagnostic', id: second.eventId,
            });
            expect(windowStatus('Diagnostic failure links')?.textContent)
                .toBe('Showing 1–40 of 45 failure links.');
            expect(container.textContent).not.toContain('failure-first-44');

            await render(model({ diagnostics: [] }), {
                kind: 'diagnostic', id: second.eventId,
            });
            expect(container.textContent).toContain(
                'The selected diagnostic diagnostic::second\u2067|\u2069 is not in this snapshot.',
            );
            expect(container.querySelector('#monitor-inspector-diagnostic-failure-links'))
                .toBeNull();
            expect(container.querySelector('[aria-label="Diagnostic failure links window"]'))
                .toBeNull();
        });

    it('browses 65 role-scoped recipe choices at 60 and resets for another recipe',
        async () => {
            const recipeId = 'recipe::\u2067shared|id\u2069';
            const rows = recipeRows(recipeId, 65);
            const onSelect = await render(model({ recipes: rows }), {
                kind: 'recipe', id: recipeId,
            });

            expect(windowStatus('Role recipe choices')?.textContent)
                .toBe('Showing 1–60 of 65 role choices.');
            expect(windowButtons('monitor-inspector-role-recipe-choices')).toHaveLength(60);
            await act(async () => controlButton('Role recipe choices', 'Next').click());
            expect(windowButtons('monitor-inspector-role-recipe-choices')).toHaveLength(5);
            const lateRow = rows[64]!;
            const late = windowButtons('monitor-inspector-role-recipe-choices')
                .find(button => button.textContent?.includes(lateRow.role!));
            expect(late).toBeDefined();
            expect([...late!.querySelectorAll('[data-exact-identifier] code')]
                .map(node => node.textContent)).toContain(lateRow.role);
            await act(async () => late?.click());
            expect(onSelect).toHaveBeenLastCalledWith({
                kind: 'recipe',
                id: createMonitorRecipeEvidenceSelectionId({
                    recipeId, role: lateRow.role, profile: lateRow.profile,
                }),
            }, {
                agentId: undefined,
                recipeId,
                commandId: undefined,
            });

            const nextRecipeId = 'recipe-next';
            await render(model({ recipes: recipeRows(nextRecipeId, 65) }), {
                kind: 'recipe', id: nextRecipeId,
            });
            expect(windowStatus('Role recipe choices')?.textContent)
                .toBe('Showing 1–60 of 65 role choices.');
            expect(container.textContent).not.toContain(lateRow.role!);
        });

    it('does not render window controls at or below an inspector budget', async () => {
        const commandId = 'command-budget';
        await render(model({
            events: Array.from({ length: 16 }, (_, index) =>
                event(`budget-${index}`, commandId)),
        }), { kind: 'command', id: commandId });

        expect(container.querySelector('[aria-label="Command evidence window"]')).toBeNull();
        expect(windowButtons('monitor-inspector-command-evidence')).toHaveLength(16);
        const first = windowButtons('monitor-inspector-command-evidence')[0]!;
        first.focus();
        expect(document.activeElement).toBe(first);
        expect(first.type).toBe('button');
    });

    it.each(['later content row', 'window control'] as const)(
        'recovers a focused %s when a same-context inspector poll drops below budget',
        async (focusedTarget) => {
            const commandId = 'command-poll-shrink';
            const events = (count: number) => Array.from(
                { length: count },
                (_, index) => event(`poll-event-${index}`, commandId),
            );
            await render(model({ events: events(20) }), {
                kind: 'command', id: commandId,
            });
            await act(async () => controlButton('Command evidence', 'Next').click());
            expect(windowStatus('Command evidence')?.textContent)
                .toBe('Showing 17–20 of 20 linked items.');
            const target = focusedTarget === 'later content row'
                ? windowButtons('monitor-inspector-command-evidence')[0]
                : controlButton('Command evidence', 'Previous');
            target?.focus();
            expect(document.activeElement).toBe(target);

            await render(model({ events: events(8) }), {
                kind: 'command', id: commandId,
            });
            const anchor = container.querySelector<HTMLElement>(
                '[data-monitor-window-focus-anchor="Command evidence"]',
            );
            expect(document.activeElement).toBe(anchor);
            expect(anchor?.textContent).toContain('Showing 1–8 of 8 linked items');
            expect(container.querySelector(
                '[aria-label="Command evidence window"]',
            )).toBeNull();
            expect(container.querySelector('[data-monitor-window-outside]')).toBeNull();
            expect(windowButtons('monitor-inspector-command-evidence').map(
                button => button.textContent,
            )).toEqual(Array.from(
                { length: 8 },
                (_, index) => `Eventpoll-event-${index}`,
            ));
            expect(container.querySelectorAll('[aria-live]')).toHaveLength(0);
        },
    );

    it('recovers focused Next when first command evidence shrinks from 17 to 16',
        async () => {
            const commandId = 'command-threshold-shrink';
            const events = (count: number) => Array.from(
                { length: count },
                (_, index) => event(`threshold-event-${index}`, commandId),
            );
            await render(model({ events: events(17) }), {
                kind: 'command', id: commandId,
            });
            const next = controlButton('Command evidence', 'Next');
            next.focus();
            expect(document.activeElement).toBe(next);

            await render(model({ events: events(16) }), {
                kind: 'command', id: commandId,
            });
            const anchor = container.querySelector<HTMLElement>(
                '[data-monitor-window-focus-anchor="Command evidence"]',
            );
            expect(document.activeElement).toBe(anchor);
            expect(anchor?.textContent).toContain('Showing 1–16 of 16 linked items');
            expect(container.querySelector(
                '[aria-label="Command evidence window"]',
            )).toBeNull();
            expect(windowButtons('monitor-inspector-command-evidence')).toHaveLength(16);
        });

    function windowStatus(label: string): HTMLElement | null {
        return container.querySelector(
            `[role="group"][aria-label="${label} window"] [role="status"]`,
        );
    }

    function controlButton(label: string, text: 'Previous' | 'Next'): HTMLButtonElement {
        const button = [...container.querySelectorAll<HTMLButtonElement>(
            `[role="group"][aria-label="${label} window"] button`,
        )].find(candidate => candidate.textContent === text);
        if (!button) throw new Error(`${text} ${label} button is unavailable.`);
        return button;
    }

    function windowButtons(contentId: string): HTMLButtonElement[] {
        return [...container.querySelectorAll<HTMLButtonElement>(`#${contentId} button`)];
    }
});

function model(input: ModelCollections = {}): MonitorWorkspaceModel {
    return {
        source: {
            contextKey: input.contextKey ?? 'monitor-context-a',
            freshness: 'current',
            controlRun: { agents: [] },
        },
        monitor: {
            distributedRunId: 'distributed-run-a',
            artifact: { status: 'invalid', message: 'No retained artifact.', fileCount: 0 },
            agentProgress: [],
            recipeProgress: input.recipes ?? [],
            failures: input.failures ?? [],
            runtimeDiagnostics: input.diagnostics ?? [],
            timeline: input.timeline ?? [],
            events: input.events ?? [],
            compositeDrilldowns: [],
        },
        report: { nextActions: [] },
    } as unknown as MonitorWorkspaceModel;
}

function failure(key: string, commandId: string): DistributedRunFailureRow {
    return {
        kind: 'command', key, commandId, agentId: 'agent-a',
        message: `Failure ${key}`, atEpochMs: 1,
    };
}

function diagnostic(
    eventId: string,
    commandId: string,
    correlatedFailureKeys: readonly string[] = [],
): DistributedRunRuntimeDiagnosticRow {
    return {
        eventId, commandId, correlatedFailureKeys,
        agentId: 'agent-a', atEpochMs: 2, severity: 'error',
        topic: 'rtc', diagnosticTypeId: 'test-diagnostic',
        message: eventId, summary: eventId, payloadSummary: '{}',
    };
}

function timelineItem(id: string, commandId: string): DistributedRunTimelineItem {
    return {
        id, commandId, agentId: 'agent-a', atEpochMs: 3,
        kind: 'command', label: id, tone: 'active',
    };
}

function event(eventId: string, commandId: string): DistributedRunEventRow {
    return {
        eventId, commandId, agentId: 'agent-a', atEpochMs: 4,
        kind: 'message', summary: eventId, payloadSummary: '{}',
    };
}

function recipeRows(recipeId: string, count: number): DistributedRunRecipeProgressRow[] {
    return Array.from({ length: count }, (_, index) => ({
        recipeId,
        profile: `profile-${index}`,
        role: index === count - 1 ? 'role::last\u2067|\u2069' : `role-${index}`,
        required: true,
        targetCount: 1,
        queuedCount: 0,
        runningCount: 0,
        passedCount: 1,
        failedCount: 0,
        missingCount: 0,
    }));
}
