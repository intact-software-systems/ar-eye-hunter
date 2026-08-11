// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlRunSnapshot } from
    '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import { projectDistributedRecipeCatalog } from
    '../../../packages/shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import type { DistributedRecipeTargetRow } from
    '../../../packages/shared-test/rallar-bb-test/distributed-run-monitor.ts';
import { deriveExecuteManifest, type ExecuteTargetResolutionEvidence } from
    '../../../apps/rallar-black-box/src/recipe-console/execute/execute-manifest.ts';
import { ExecuteManifestDisclosure } from
    '../../../apps/rallar-black-box/src/recipe-console/execute/ExecuteManifestDisclosure.tsx';
import { ExecutePreflight } from
    '../../../apps/rallar-black-box/src/recipe-console/execute/ExecutePreflight.tsx';
import { ExecuteRecipeInspector } from
    '../../../apps/rallar-black-box/src/recipe-console/execute/ExecuteRecipeInspector.tsx';
import { ExecuteTargets } from
    '../../../apps/rallar-black-box/src/recipe-console/execute/ExecuteTargets.tsx';
import type { ExecuteAgentLaunchModel } from
    '../../../apps/rallar-black-box/src/recipe-console/execute/use-execute-agent-launch.ts';
import type { RecipeConsoleControlConnection } from
    '../../../apps/rallar-black-box/src/recipe-console/control/ControlConnectionProvider.tsx';
import { createExecuteTargetRowKeys } from
    '../../../apps/rallar-black-box/src/recipe-console/execute/ExecuteTargetWindow.tsx';
import { ExecuteWindowedList } from
    '../../../apps/rallar-black-box/src/recipe-console/execute/ExecuteWindowedList.tsx';
import {
    EXECUTE_WINDOW_BUDGETS,
    createExecuteWindowFingerprint,
} from '../../../apps/rallar-black-box/src/recipe-console/execute/execute-window-contract.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const catalogEntry = projectDistributedRecipeCatalog().entries[0]!;
const executeTargetGroup = {
    applicationId: 'app',
    workspaceId: 'workspace',
    groupId: 'group',
} as const;
const executeTargetAgentLaunch = {
    expanded: false,
    setExpanded: () => undefined,
    runId: 'window-control-run',
    setRunId: () => undefined,
    prefix: 'window-agent',
    setPrefix: () => undefined,
    count: 3,
    setCount: () => undefined,
    group: executeTargetGroup,
    agentIds: ['window-agent-1', 'window-agent-2', 'window-agent-3'],
    blockedAgentIds: [],
    busyAction: undefined,
    blocker: undefined,
    message: undefined,
    launchedExpectedCount: 0,
    launchedReadyCount: 0,
    launchPreparationPending: false,
    launchedCohortSelectionPending: false,
    openAgents: () => undefined,
    copyAgentLinks: async () => undefined,
    copyAgentLink: async () => undefined,
} satisfies ExecuteAgentLaunchModel;
const executeTargetControlConnection = {
    bootstrap: {
        apiBaseUrl: 'https://api.example.test',
        providerMode: 'simulated',
        bootstrapGroup: executeTargetGroup,
    },
    baseUrl: 'https://control.example.test',
    browserAgentLaunch: undefined,
    execution: undefined,
    retention: undefined,
    fleet: undefined,
    query: {
        status: 'live',
        reachability: 'reachable',
        authorization: 'ready',
        isRefreshing: false,
    },
    refresh: async () => undefined,
    refreshAfterCurrent: async () => undefined,
} satisfies RecipeConsoleControlConnection;
const executeTargetDependencies = {
    agentLaunch: executeTargetAgentLaunch,
    controlConnection: executeTargetControlConnection,
};

describe('Recipe Console Execute pressure-window contract', () => {
    it('caps every proven Execute pressure owner at 100 with collision-safe fingerprints', () => {
        expect(EXECUTE_WINDOW_BUDGETS).toEqual({
            targets: 100,
            resolution: 100,
            preflightRows: 100,
            preflightIssues: 100,
            manifestErrors: 100,
            inspectorCommands: 100,
            inspectorPrerequisites: 100,
        });
        const fingerprint = createExecuteWindowFingerprint({
            contextKey: 'run\u0000,]\u202e["late',
            section: 'targets',
        });
        expect(JSON.parse(fingerprint)).toEqual([
            'execute-window-v1',
            'run\u0000,]\u202e["late',
            'targets',
        ]);
    });

    });

describe('Recipe Console Execute pressure windows', () => {
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

    async function render(node: React.ReactNode): Promise<void> {
        await act(async () => root.render(node));
    }

    async function click(element: Element | null): Promise<void> {
        if (!(element instanceof HTMLElement)) throw new Error('Missing click target.');
        await act(async () => element.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
        })));
    }

    async function next(label: string, count = 1): Promise<void> {
        for (let index = 0; index < count; index += 1) {
            const group = [...container.querySelectorAll('[role="group"]')]
                .find(element => element.getAttribute('aria-label') === `${label} window`);
            await click([...group?.querySelectorAll('button') ?? []]
                .find(button => button.textContent === 'Next') ?? null);
        }
    }

    function windowGroup(label: string): HTMLElement | undefined {
        return [...container.querySelectorAll<HTMLElement>('[role="group"]')]
            .find(element => element.getAttribute('aria-label') === `${label} window`);
    }

    it('keeps 250 control runs searchable, rejects ambiguous identities, and windows 240 target rows', async () => {
        const runs = Array.from({ length: 250 }, (_, index) => controlRun(index));
        const rows = Array.from({ length: 240 }, (_, index) => targetRow(index));
        const onSelectControlRun = vi.fn();
        const onToggle = vi.fn();
        await render(createElement(ExecuteTargets, {
            ...executeTargetDependencies,
            connection: 'live',
            controlRunId: runs[249]!.runId,
            controlRuns: runs,
            onSelectControlRun,
            onToggle,
            rows,
            selectedAgentIds: [rows[239]!.agentId],
        }));

        expect(container.querySelectorAll('[data-execute-target]')).toHaveLength(100);
        expect(container.textContent).toContain('Showing 1–100 of 240 targets.');
        await next('Targets', 2);
        expect(container.querySelectorAll('[data-execute-target]')).toHaveLength(40);
        expect(container.textContent).toContain(rows[239]!.agentId);
        await click(container.querySelector(`input[aria-label="Select ${rows[239]!.agentId}"]`));
        expect(onToggle).toHaveBeenCalledExactlyOnceWith(rows[239]!.agentId);
        expect(onSelectControlRun).not.toHaveBeenCalled();

        await click(container.querySelector('[data-searchable-listbox-trigger]'));
        expect(container.querySelectorAll('[role="option"]')).toHaveLength(50);
        expect(container.textContent).toContain(runs[249]!.runId);
        expect(container.querySelector('select')).toBeNull();

        await render(createElement(ExecuteTargets, {
            ...executeTargetDependencies,
            connection: 'live',
            controlRunId: 'duplicate-run',
            controlRunIssue: 'Control run identity is ambiguous.',
            controlRuns: [controlRun(0, 'duplicate-run'), controlRun(1, 'duplicate-run')],
            onSelectControlRun,
            onToggle,
            rows: [],
            selectedAgentIds: [],
        }));
        expect(container.querySelector('[data-searchable-listbox-key-error]')?.textContent)
            .toContain('Duplicate key duplicate-run');
        const trigger = container.querySelector('[data-searchable-listbox-trigger]');
        expect(trigger?.getAttribute('aria-describedby'))
            .toBe('execute-control-run-issue');
        expect(trigger?.getAttribute('aria-invalid')).toBe('true');
        expect(onSelectControlRun).not.toHaveBeenCalled();
    });

    it('recovers focused window content when an update drops below the control budget', async () => {
        function list(items: readonly string[]) {
            return createElement(ExecuteWindowedList, {
                contentId: 'execute-focus-window',
                contextKey: 'stable-context',
                itemKey: item => item,
                itemLabel: 'rows',
                items,
                label: 'Focus rows',
                ordered: true,
                renderItem: item => createElement('li', {},
                    createElement('button', { type: 'button' }, item)),
                revisionKey: JSON.stringify(items),
                section: 'preflightRows' as const,
            });
        }
        await render(list(Array.from({ length: 240 }, (_, index) => `row-${index}`)));
        expect((container.querySelector('ol') as HTMLOListElement).start).toBe(1);
        await next('Focus rows');
        expect((container.querySelector('ol') as HTMLOListElement).start).toBe(101);
        const focused = [...container.querySelectorAll('button')]
            .find(button => button.textContent === 'row-100');
        focused?.focus();
        expect(document.activeElement).toBe(focused);

        await render(list(Array.from({ length: 80 }, (_, index) => `row-${index}`)));
        expect(container.querySelector('[aria-label="Focus rows window"]')).toBeNull();
        expect(document.activeElement).toBe(
            container.querySelector('[data-execute-window-focus-anchor="preflightRows"]'),
        );
    });

    it('recovers focused targets after operational truth changes without a window revision',
        async () => {
            const rows = Array.from({ length: 240 }, (_, index) => targetRow(index));
            const props = {
                ...executeTargetDependencies,
                connection: 'live' as const,
                controlRunId: 'stable-control-run',
                controlRuns: [],
                disabled: false,
                onSelectControlRun: vi.fn(),
                onToggle: vi.fn(),
                rows,
                selectedAgentIds: rows.map(row => row.agentId),
                selectionLocked: false,
            };
            const anchor = () => container.querySelector(
                '[data-execute-window-focus-anchor="targets"]',
            );
            const lateCheckbox = () => container.querySelector<HTMLInputElement>(
                `input[aria-label="Select ${rows[239]!.agentId}"]`,
            );
            await render(createElement(ExecuteTargets, props));
            await next('Targets', 2);
            expect(anchor()?.textContent).toBe('Showing 201–240 of 240 targets.');

            lateCheckbox()?.focus();
            await render(createElement(ExecuteTargets, {
                ...props,
                connection: 'stale',
            }));
            expect(anchor()?.textContent).toBe('Showing 201–240 of 240 targets.');
            expect(lateCheckbox()).toBeNull();
            expect(document.activeElement).toBe(anchor());

            await render(createElement(ExecuteTargets, props));
            lateCheckbox()?.focus();
            await render(createElement(ExecuteTargets, { ...props, disabled: true }));
            expect(lateCheckbox()?.disabled).toBe(true);
            expect(document.activeElement).toBe(anchor());

            await render(createElement(ExecuteTargets, props));
            lateCheckbox()?.focus();
            await render(createElement(ExecuteTargets, {
                ...props,
                selectionLocked: true,
            }));
            expect(lateCheckbox()?.disabled).toBe(true);
            expect(document.activeElement).toBe(anchor());
            expect(anchor()?.textContent).toBe('Showing 201–240 of 240 targets.');
        });

    it('hands boundary focus to the remaining page control in both directions', async () => {
        const items = Array.from({ length: 240 }, (_, index) => `row-${index}`);
        await render(createElement(ExecuteWindowedList, {
            contentId: 'execute-boundary-window',
            contextKey: 'boundary-context',
            itemKey: (item: string) => item,
            itemLabel: 'rows',
            items,
            label: 'Boundary rows',
            ordered: true,
            renderItem: (item: string) => createElement('li', {}, item),
            revisionKey: JSON.stringify(items),
            section: 'preflightRows' as const,
        }));
        const group = windowGroup('Boundary rows');
        const previous = [...group?.querySelectorAll('button') ?? []]
            .find(button => button.textContent === 'Previous');
        const nextButton = [...group?.querySelectorAll('button') ?? []]
            .find(button => button.textContent === 'Next');
        if (!previous || !nextButton) throw new Error('Expected boundary controls.');

        nextButton.focus();
        await click(nextButton);
        await click(nextButton);
        expect(nextButton.disabled).toBe(true);
        expect(document.activeElement).toBe(container.querySelector(
            '[data-execute-window-focus-anchor="preflightRows"]',
        ));

        previous.focus();
        await click(previous);
        await click(previous);
        expect(previous.disabled).toBe(true);
        expect(document.activeElement).toBe(container.querySelector(
            '[data-execute-window-focus-anchor="preflightRows"]',
        ));
    });

    it('preserves a browsed control-run page across semantically equal cloned polls',
        async () => {
            const runs = Array.from({ length: 250 }, (_, index) => controlRun(index));
            const props = {
                ...executeTargetDependencies,
                connection: 'live' as const,
                controlRuns: runs,
                onSelectControlRun: vi.fn(),
                onToggle: vi.fn(),
                rows: [],
                selectedAgentIds: [],
            };
            await render(createElement(ExecuteTargets, props));
            await click(container.querySelector('[data-searchable-listbox-trigger]'));
            await next('Control run options');
            expect(container.querySelector('[data-searchable-listbox-range]')?.textContent)
                .toBe('Showing 101–200 of 250 options.');

            await render(createElement(ExecuteTargets, {
                ...props,
                controlRuns: runs.map(run => ({
                    ...run,
                    agents: [...run.agents],
                })),
            }));
            expect(container.querySelector('[data-searchable-listbox-range]')?.textContent)
                .toBe('Showing 101–200 of 250 options.');
        });

    it('keeps focused target identity stable across same-context insertions and duplicate IDs collision-safe', async () => {
        const rowA = targetRow(0);
        const rowB = targetRow(1);
        const rowC = targetRow(2);
        const props = {
            ...executeTargetDependencies,
            connection: 'live' as const,
            controlRunId: 'stable-run',
            controlRuns: [],
            onSelectControlRun: vi.fn(),
            onToggle: vi.fn(),
            selectedAgentIds: [rowA.agentId, rowC.agentId],
        };
        await render(createElement(ExecuteTargets, { ...props, rows: [rowA, rowC] }));
        const focused = container.querySelector(
            `input[aria-label="Select ${rowC.agentId}"]`,
        ) as HTMLInputElement;
        focused.focus();
        await render(createElement(ExecuteTargets, {
            ...props,
            rows: [rowA, rowB, rowC],
        }));
        expect(document.activeElement?.getAttribute('aria-label'))
            .toBe(`Select ${rowC.agentId}`);
        expect(createExecuteTargetRowKeys([rowA, rowA, rowC])).toEqual([
            `["execute-target-row-v1","${rowA.agentId}",0]`,
            `["execute-target-row-v1","${rowA.agentId}",1]`,
            `["execute-target-row-v1","${rowC.agentId}",0]`,
        ]);
    });

    it('keeps late resolution evidence browseable across equal-row refreshed resolutions', async () => {
        const resolution = resolutionEvidence(240);
        const onToggle = vi.fn();
        const props = {
            ...executeTargetDependencies,
            connection: 'live',
            controlRunId: 'stable-control-run',
            controlRuns: [],
            onSelectControlRun: vi.fn(),
            onToggle,
            rows: [targetRow(0)],
            selectedAgentIds: ['agent-0000'],
        } as const;
        await render(createElement(ExecuteTargets, { ...props, resolution }));

        expect(container.querySelectorAll('[data-execute-resolution-row]')).toHaveLength(100);
        expect(container.textContent).not.toContain('late resolution issue 239');
        await next('Resolution evidence', 4);
        expect(container.querySelectorAll('[data-execute-resolution-row]')).toHaveLength(80);
        expect(container.textContent).toContain('late resolution issue 239');

        await render(createElement(ExecuteTargets, {
            ...props,
            resolution: {
                ...resolution,
                manifestFingerprint: 'refreshed-manifest',
                resolution: {
                    ...resolution.resolution,
                    blockers: resolution.resolution.blockers.map(blocker => ({ ...blocker })),
                    resolvedAtEpochMs: resolution.resolution.resolvedAtEpochMs + 1_000,
                },
                comparison: {
                    ...resolution.comparison,
                    issues: resolution.comparison.issues.map(issue => ({ ...issue })),
                },
            },
        }));
        expect(container.textContent).toContain('Showing 401–480 of 480 evidence rows.');
        expect(container.textContent).toContain('late resolution issue 239');
        expect(onToggle).not.toHaveBeenCalled();
    });

    it('windows late preflight rows and warnings while retaining full preflight counts', async () => {
        const tree = Array.from({ length: 240 }, (_, index) => ({
            path: `commands[${index}]`,
            depth: 0,
            kind: 'health' as const,
            commandId: `command-${String(index).padStart(4, '0')}`,
            label: `Command ${index}`,
            summary: index === 239 ? 'late preflight row 239' : `summary ${index}`,
            effectiveCommandCount: 1,
            details: [`detail ${index}`],
            warnings: [],
        }));
        const warnings = Array.from({ length: 240 }, (_, index) =>
            index === 239 ? 'late preflight warning 239' : `warning ${index}`);
        const entry = {
            ...catalogEntry,
            preflight: { ...catalogEntry.preflight, tree, warnings },
        };
        await render(createElement(ExecutePreflight, { entry }));

        expect(container.querySelectorAll('[data-execute-preflight-row]')).toHaveLength(100);
        expect(container.querySelectorAll('[data-execute-preflight-issue]')).toHaveLength(100);
        await next('Preflight command rows', 2);
        await next('Preflight warnings', 2);
        expect(container.textContent).toContain('late preflight row 239');
        expect(container.textContent).toContain('late preflight warning 239');
        expect(container.textContent).toContain('240 warnings total');
    });

    it('resets replaced preflight evidence at equal cardinality and preserves unrelated changes',
        async () => {
            const entry = preflightEntry('old');
            await render(createElement(ExecutePreflight, { entry }));
            await next('Preflight command rows', 2);
            expect(container.textContent).toContain('old late row 239');

            await render(createElement(ExecutePreflight, {
                entry: {
                    ...entry,
                    preflight: { ...entry.preflight, maxDepth: 99 },
                },
            }));
            expect(container.textContent).toContain('old late row 239');

            await render(createElement(ExecutePreflight, {
                entry: preflightEntry('replacement'),
            }));
            expect(container.textContent).toContain('replacement row 0');
            expect(container.textContent).not.toContain('replacement late row 239');
        });

    it('unmounts closed manifest detail and windows all late validation errors when opened', async () => {
        const base = deriveExecuteManifest({
            controlRunId: 'control-run',
            distributedRunId: 'distributed-run',
            group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'group' },
            selectedAgentIds: ['agent'],
            selectedRecipe: catalogEntry,
        });
        const errors = Array.from({ length: 240 }, (_, index) => ({
            source: 'contract' as const,
            path: `$.errors[${index}]`,
            message: index === 239 ? 'late manifest error 239' : `error ${index}`,
        }));
        const draft = { ...base, validation: { ...base.validation, ok: false as const, errors } };
        await render(createElement(ExecuteManifestDisclosure, { draft }));

        expect(container.querySelector('[data-execute-manifest-body]')).toBeNull();
        expect(container.querySelector('pre')).toBeNull();
        await click(container.querySelector('[data-execute-manifest] summary'));
        expect(container.querySelectorAll('[data-execute-manifest-error]')).toHaveLength(100);
        await next('Manifest validation errors', 2);
        expect(container.textContent).toContain('late manifest error 239');
        await click(container.querySelector('[data-execute-manifest] summary'));
        expect(container.querySelector('[data-execute-manifest-body]')).toBeNull();
    });

    it('windows 240 inspector commands and prerequisites and reaches their exact late IDs', async () => {
        const command = catalogEntry.item.recipe.commands[0]!;
        const commands = Array.from({ length: 240 }, (_, index) => ({
            ...command,
            commandId: `exact-command-${String(index).padStart(4, '0')}`,
            label: index === 239 ? 'late inspector command 239' : `Command ${index}`,
        }));
        const prerequisites = Array.from({ length: 240 }, (_, index) =>
            index === 239 ? 'late prerequisite 239' : `Prerequisite ${index}`);
        const entry = {
            ...catalogEntry,
            item: {
                ...catalogEntry.item,
                prerequisites,
                recipe: { ...catalogEntry.item.recipe, commands },
            },
        };
        await render(createElement(ExecuteRecipeInspector, {
            entry,
            selectedTargetCount: 240,
        }));

        expect(container.querySelectorAll('[data-execute-inspector-command]')).toHaveLength(100);
        expect(container.querySelectorAll('[data-execute-inspector-prerequisite]')).toHaveLength(100);
        await next('Inspector commands', 2);
        await next('Inspector prerequisites', 2);
        expect(container.textContent).toContain('late inspector command 239');
        expect(container.textContent).toContain('exact-command-0239');
        expect(container.textContent).toContain('late prerequisite 239');
    });

    it('keys inspector windows to their own evidence instead of unrelated manifest state',
        async () => {
            const entry = inspectorEntry('old');
            const firstManifest = manifestDraft('manifest-a');
            await render(createElement(ExecuteRecipeInspector, {
                entry,
                manifest: firstManifest,
                selectedTargetCount: 1,
            }));
            await next('Inspector commands', 2);
            await next('Inspector prerequisites', 2);
            expect(container.textContent).toContain('old late command 239');
            expect(container.textContent).toContain('old late prerequisite 239');

            await render(createElement(ExecuteRecipeInspector, {
                entry,
                manifest: manifestDraft('manifest-b'),
                selectedTargetCount: 99,
            }));
            expect(container.textContent).toContain('old late command 239');
            expect(container.textContent).toContain('old late prerequisite 239');

            await render(createElement(ExecuteRecipeInspector, {
                entry: inspectorEntry('replacement'),
                manifest: manifestDraft('manifest-b'),
                selectedTargetCount: 99,
            }));
            expect(container.textContent).toContain('replacement command 0');
            expect(container.textContent).toContain('replacement prerequisite 0');
            expect(container.textContent).not.toContain('replacement late command 239');
        });

    it('keeps window controls and nested live regions outside alert/status summaries',
        async () => {
            await render(createElement(ExecutePreflight, {
                entry: preflightEntry('live-region', { warnings: 240 }),
            }));
            expect(container.querySelector('[role="alert"] [role="group"]')).toBeNull();
            expect(container.querySelector('[role="status"] [role="group"]')).toBeNull();
            expect(container.querySelector('[role="alert"] [role="status"]')).toBeNull();
            const summary = container.querySelector('[data-execute-preflight-live-summary]');
            expect(summary?.getAttribute('role')).toBe('status');
            expect(summary?.textContent).toContain('240 warnings');
        });
});

function preflightEntry(
    prefix: string,
    options: Readonly<{ warnings?: number }> = {},
) {
    const tree = Array.from({ length: 240 }, (_, index) => ({
        path: `commands[${index}]`,
        depth: 0,
        kind: 'health' as const,
        commandId: `${prefix}-command-${index}`,
        label: `${prefix} command ${index}`,
        summary: index === 239 ? `${prefix} late row 239` : `${prefix} row ${index}`,
        effectiveCommandCount: 1,
        details: [],
        warnings: [],
    }));
    const warnings = Array.from({ length: options.warnings ?? 0 }, (_, index) =>
        `${prefix} warning ${index}`
    );
    return {
        ...catalogEntry,
        preflight: {
            ...catalogEntry.preflight,
            manifestCommandCount: 240,
            effectiveCommandCount: 240,
            tree,
            warnings,
        },
    };
}

function inspectorEntry(prefix: string) {
    const base = catalogEntry.item.recipe.commands[0]!;
    return {
        ...catalogEntry,
        item: {
            ...catalogEntry.item,
            prerequisites: Array.from({ length: 240 }, (_, index) =>
                index === 239
                    ? `${prefix} late prerequisite 239`
                    : `${prefix} prerequisite ${index}`
            ),
            recipe: {
                ...catalogEntry.item.recipe,
                commands: Array.from({ length: 240 }, (_, index) => ({
                    ...base,
                    commandId: `${prefix}-command-${index}`,
                    label: index === 239
                        ? `${prefix} late command 239`
                        : `${prefix} command ${index}`,
                })),
            },
        },
    };
}

function manifestDraft(distributedRunId: string) {
    return deriveExecuteManifest({
        controlRunId: 'control-run',
        distributedRunId,
        group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'group' },
        selectedAgentIds: ['agent'],
        selectedRecipe: catalogEntry,
    });
}

function controlRun(index: number, runId = `control-run-${String(index).padStart(4, '0')}`): ControlRunSnapshot {
    return {
        runId,
        createdAtEpochMs: index,
        updatedAtEpochMs: index,
        agents: Array.from({ length: index % 4 }, () => ({} as never)),
        commands: [], results: [], events: [], stats: [], reports: [], heartbeats: [],
    };
}

function targetRow(index: number): DistributedRecipeTargetRow {
    const agentId = `agent-${String(index).padStart(4, '0')}`;
    return {
        agentId,
        connected: true,
        status: 'matched',
        targetable: true,
        reason: 'Current and safe.',
        principalId: `${agentId}-principal`,
        sessionId: `${agentId}-session`,
        applicationId: 'app', workspaceId: 'workspace', groupId: 'group',
        lastSeenAtEpochMs: index,
    };
}

function resolutionEvidence(count: number): ExecuteTargetResolutionEvidence {
    const blockers = Array.from({ length: count }, (_, index) => ({
        agentId: `blocked-${index}`,
        status: 'offline-agent' as const,
        reason: `blocker ${index}`,
    }));
    const issues = Array.from({ length: count }, (_, index) => ({
        code: 'target-mismatch' as const,
        agentId: `issue-${index}`,
        message: index === count - 1 ? `late resolution issue ${index}` : `issue ${index}`,
    }));
    return {
        manifestFingerprint: 'manifest',
        resolution: {
            group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'group' },
            resolvedAtEpochMs: 1,
            staleAfterMs: 30_000,
            targetPolicyMode: 'selected-agents',
            targetAgentIds: [], roleAssignments: [], blockers,
            summary: {
                agents: count, targetable: 0, selected: 0,
                missingExpectedParticipants: 0, staleAgents: 0,
                offlineAgents: count, wrongGroupAgents: 0,
                agentsWithoutIdentity: 0, roleCounts: {}, regions: {}, providers: {},
            },
        },
        comparison: { ok: false, issues },
    };
}
