// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecipeConsoleActiveWork } from
    '../../../apps/rallar-black-box/src/recipe-console/app/RecipeConsoleActiveWork.tsx';
import AdvancedWorkspace from
    '../../../apps/rallar-black-box/src/recipe-console/advanced/AdvancedWorkspace.tsx';
import { ADVANCED_DIAGNOSTIC_QUERY_MAX_BYTES } from
    '../../../apps/rallar-black-box/src/recipe-console/advanced/advanced-legacy-href.ts';
import { ADVANCED_SURFACE_CATALOG } from
    '../../../apps/rallar-black-box/src/recipe-console/advanced/advanced-surface-catalog.ts';
import type { RecipeConsoleControlSelection } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-selection-contract.ts';
import type {
    RecipeConsoleUrlIssue,
    RecipeConsoleUrlState,
} from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const ADVANCED_ROOT = 'apps/rallar-black-box/src/recipe-console/advanced';
const ACTIVE_WORK_PATH =
    'apps/rallar-black-box/src/recipe-console/app/RecipeConsoleActiveWork.tsx';
const WORKSPACE_PATH =
    'apps/rallar-black-box/src/recipe-console/app/RecipeConsoleWorkspace.tsx';

const URL_STATE: RecipeConsoleUrlState = {
    v: 1,
    experience: 'recipe-console',
    view: 'advanced',
    controlRunId: 'control/run',
    distributedRunId: 'distributed run',
    agentId: 'agent-\u202e-a',
    recipeId: 'recipe-a',
    commandId: 'command-a',
    transport: 'rtc',
};

describe('Recipe Console Advanced workspace', () => {
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

    it('renders every actionable leaf once under the three approved headings', async () => {
        await renderAdvanced(root, {
            sourceSearch: '?provider=browser-rallar',
            selection: selection(),
            urlIssues: [],
            urlState: URL_STATE,
        });

        expect(headings(container, 'h2')).toEqual([
            'Current diagnostic context',
            'Direct Diagnostics',
            'Preserved Workflow Fallbacks',
            'Advanced Legacy',
        ]);
        expect(categoryLinks(container, 'direct-diagnostics')).toHaveLength(13);
        expect(categoryLinks(container, 'workflow-fallbacks')).toHaveLength(4);
        expect(categoryLinks(container, 'advanced-legacy')).toHaveLength(5);

        const links = [...container.querySelectorAll<HTMLAnchorElement>(
            '[data-advanced-surface-link]',
        )];
        expect(links).toHaveLength(22);
        expect(new Set(links.map(link => link.dataset.surfaceId))).toEqual(
            new Set(ADVANCED_SURFACE_CATALOG.map(surface => surface.id)),
        );
        expect(links.every(link => link.getAttribute('href')?.startsWith('/?')))
            .toBe(true);
        expect(links.every(link => link.getAttribute('role') === null)).toBe(true);
        expect(links.some(link => link.textContent?.trim() === 'Advanced'))
            .toBe(false);
    });

    it('builds canonical links from provider and root selection context only', async () => {
        await renderAdvanced(root, {
            sourceSearch: '?' + new URLSearchParams({
                provider: 'browser-rallar',
                applicationId: 'raw-url-app',
                workspaceId: 'raw-url-workspace',
                groupId: 'raw-url-group',
                token: 'secret-token',
                controlUrl: 'wss://control.test/private',
                returnTo: 'https://attacker.test/steal',
            }),
            selection: selection(),
            urlIssues: [],
            urlState: URL_STATE,
        });

        const auth = surfaceUrl(container, 'direct.auth');
        expect(Object.fromEntries(auth.searchParams)).toEqual({
            experience: 'legacy',
            workspace: 'rallar',
            tab: 'auth',
            legacySurface: 'direct.auth',
            diagnosticContext: '1',
            view: 'advanced',
            provider: 'browser-rallar',
            contextApplicationId: 'selected/app',
            contextWorkspaceId: 'selected workspace',
            contextGroupId: 'selected-group',
            controlRunId: 'control/run',
            distributedRunId: 'distributed run',
            agentId: 'agent-\u202e-a',
            recipeId: 'recipe-a',
            commandId: 'command-a',
            transport: 'rtc',
        });
        const allHrefs = [...container.querySelectorAll<HTMLAnchorElement>(
            '[data-advanced-surface-link]',
        )].map(link => link.href).join('\n');
        expect(allHrefs).not.toMatch(
            /raw-url|secret-token|control\.test|attacker|returnTo/i,
        );

        expect(container.textContent).toContain('Selected distributed run context');
        for (const exact of [
            'selected/app',
            'selected workspace',
            'selected-group',
            'control/run',
            'distributed run',
            'agent-\u202e-a',
            'recipe-a',
            'command-a',
            'rtc',
        ]) {
            const node = [...container.querySelectorAll('[data-exact-identifier]')]
                .find(candidate => candidate.textContent === exact);
            expect(node, exact).toBeDefined();
            expect(node?.getAttribute('dir')).toBe('ltr');
        }
    });

    it('states invalid provider and unavailable selection without forcing simulation', async () => {
        const unavailableSelection = selection({
            issues: [
                {
                    field: 'controlRunId',
                    code: 'unavailable',
                    message: 'Control run missing-control is unavailable.',
                    value: 'missing-control',
                },
                {
                    field: 'agentId',
                    code: 'unavailable',
                    message: 'Agent missing-agent is unavailable.',
                    value: 'missing-agent',
                },
            ],
            controlRunId: 'missing-control',
            agentId: 'missing-agent',
        });
        const urlIssues: readonly RecipeConsoleUrlIssue[] = [{
            field: 'recipeId',
            code: 'invalid',
            value: 'unsafe recipe',
            message: 'recipeId was invalid and omitted.',
        }];
        await renderAdvanced(root, {
            sourceSearch: '?provider=filesystem&provider=simulated',
            selection: unavailableSelection,
            urlIssues,
            urlState: {
                ...URL_STATE,
                controlRunId: 'missing-control',
                agentId: 'missing-agent',
                recipeId: undefined,
            },
        });

        expect(contextRow(container, 'provider').dataset.contextStatus)
            .toBe('invalid');
        expect(contextRow(container, 'provider').textContent)
            .toContain('Unsupported or duplicate provider omitted');
        expect(container.textContent).toContain(
            'Control run missing-control is unavailable.',
        );
        expect(container.textContent).toContain('Agent missing-agent is unavailable.');
        expect(container.textContent).toContain('recipeId was invalid and omitted.');
        expect(contextRow(container, 'recipeId').dataset.contextStatus)
            .toBe('invalid');

        const hrefs = [...container.querySelectorAll<HTMLAnchorElement>(
            '[data-advanced-surface-link]',
        )].map(link => link.getAttribute('href')).join('\n');
        expect(hrefs).not.toMatch(/provider=|simulated|filesystem/);
    });

    it('shows empty optional context without inventing a provider or run selection', async () => {
        await renderAdvanced(root, {
            sourceSearch: '',
            selection: selection({
                controlRunId: undefined,
                distributedRunId: undefined,
                agentId: undefined,
            }),
            urlIssues: [],
            urlState: {
                v: 1,
                experience: 'recipe-console',
                view: 'advanced',
            },
        });

        expect(contextRow(container, 'provider').dataset.contextStatus)
            .toBe('absent');
        for (const field of [
            'controlRunId',
            'distributedRunId',
            'agentId',
            'recipeId',
            'commandId',
            'transport',
        ]) {
            expect(contextRow(container, field).dataset.contextStatus, field)
                .toBe('absent');
            expect(contextRow(container, field).textContent, field)
                .toContain('Not selected');
        }
        const hrefs = [...container.querySelectorAll<HTMLAnchorElement>(
            '[data-advanced-surface-link]',
        )].map(link => link.getAttribute('href')).join('\n');
        expect(hrefs).not.toMatch(
            /provider=|controlRunId=|distributedRunId=|agentId=|recipeId=|commandId=|transport=/,
        );
    });

    it('prioritizes return selection and marks group context omitted by the query budget', async () => {
        const largeState: RecipeConsoleUrlState = {
            ...URL_STATE,
            controlRunId: 'c'.repeat(300),
            distributedRunId: 'd'.repeat(300),
            agentId: 'a'.repeat(300),
            recipeId: 'r'.repeat(300),
            commandId: 'm'.repeat(300),
        };
        const largeSelection = selection({
            controlRunId: largeState.controlRunId,
            distributedRunId: largeState.distributedRunId,
            agentId: largeState.agentId,
            groupContext: {
                source: 'selected-distributed-run',
                group: {
                    applicationId: 'p'.repeat(900),
                    workspaceId: 'w'.repeat(900),
                    groupId: 'g'.repeat(900),
                },
            },
        });
        await renderAdvanced(root, {
            sourceSearch: '?provider=browser-rallar',
            selection: largeSelection,
            urlIssues: [],
            urlState: largeState,
        });

        const links = [...container.querySelectorAll<HTMLAnchorElement>(
            '[data-advanced-surface-link]',
        )];
        for (const link of links) {
            const url = new URL(link.href);
            for (const field of [
                'controlRunId',
                'distributedRunId',
                'agentId',
                'recipeId',
                'commandId',
            ] as const) {
                expect(url.searchParams.get(field), `${link.dataset.surfaceId} ${field}`)
                    .toBe(largeState[field]);
            }
            expect(utf8Bytes(url.search.slice(1)))
                .toBeLessThanOrEqual(ADVANCED_DIAGNOSTIC_QUERY_MAX_BYTES);
        }
        for (const field of [
            'controlRunId',
            'distributedRunId',
            'agentId',
            'recipeId',
            'commandId',
        ]) {
            expect(contextRow(container, field).dataset.contextStatus, field)
                .toBe('ready');
        }
        const groupRows = ['applicationId', 'workspaceId', 'groupId']
            .map(field => contextRow(container, field));
        expect(groupRows.some(row => row.dataset.contextStatus === 'omitted'))
            .toBe(true);
        expect(groupRows.filter(row => row.dataset.contextStatus === 'omitted')
            .every(row => row.textContent?.includes('query budget'))).toBe(true);
    });

    it('marks unavailable context omitted when the aggregate budget drops it', async () => {
        const unavailableAgentId = 'a'.repeat(1_500);
        const largeState: RecipeConsoleUrlState = {
            v: 1,
            experience: 'recipe-console',
            view: 'advanced',
            controlRunId: 'c'.repeat(1_500),
            distributedRunId: 'd'.repeat(1_500),
            agentId: unavailableAgentId,
        };
        await renderAdvanced(root, {
            sourceSearch: '',
            selection: selection({
                controlRunId: largeState.controlRunId,
                distributedRunId: largeState.distributedRunId,
                agentId: unavailableAgentId,
                issues: [{
                    field: 'agentId',
                    code: 'unavailable',
                    message: 'Requested agent is unavailable.',
                    value: unavailableAgentId,
                }],
            }),
            urlIssues: [],
            urlState: largeState,
        });

        const row = contextRow(container, 'agentId');
        expect(row.dataset.contextStatus).toBe('omitted');
        expect(row.textContent).toContain('Requested agent is unavailable.');
        expect(row.textContent).toContain('query budget');
        for (const link of container.querySelectorAll<HTMLAnchorElement>(
            '[data-advanced-surface-link]',
        )) {
            expect(new URL(link.href).searchParams.has('agentId')).toBe(false);
        }
    });

    it('marks present control-bearing values invalid instead of absent', async () => {
        const unsafeState = {
            ...URL_STATE,
            recipeId: 'recipe\u0000id',
            commandId: 'command\u0085id',
        } as RecipeConsoleUrlState;
        await renderAdvanced(root, {
            sourceSearch: '',
            selection: selection(),
            urlIssues: [],
            urlState: unsafeState,
        });

        for (const field of ['recipeId', 'commandId']) {
            const row = contextRow(container, field);
            expect(row.dataset.contextStatus, field).toBe('invalid');
            expect(row.textContent, field).toContain('Invalid value omitted');
        }
        for (const link of container.querySelectorAll<HTMLAnchorElement>(
            '[data-advanced-surface-link]',
        )) {
            const params = new URL(link.href).searchParams;
            expect(params.has('recipeId')).toBe(false);
            expect(params.has('commandId')).toBe(false);
        }
    });

    it('loads only for the active Advanced branch and unmounts on exit', async () => {
        const props = {
            advanced: {
                sourceSearch: '',
                selection: selection(),
                urlIssues: [],
                urlState: URL_STATE,
            },
            analyzeWork: createElement('p', null, 'Analyze owner'),
            executeWork: createElement('p', null, 'Execute owner'),
            fleet: {} as never,
            monitorWork: createElement('p', null, 'Monitor owner'),
            tune: {} as never,
        };

        await act(async () => root.render(createElement(
            RecipeConsoleActiveWork,
            { ...props, view: 'execute' },
        )));
        expect(container.textContent).toBe('Execute owner');
        expect(container.querySelector('[data-advanced-workspace]')).toBeNull();

        await act(async () => root.render(createElement(
            RecipeConsoleActiveWork,
            { ...props, view: 'advanced' },
        )));
        expect(container.querySelector('[data-advanced-workspace]')).not.toBeNull();

        await act(async () => root.render(createElement(
            RecipeConsoleActiveWork,
            { ...props, view: 'execute' },
        )));
        expect(container.querySelector('[data-advanced-workspace]')).toBeNull();
        expect(container.textContent).toBe('Execute owner');
    });

    });

async function renderAdvanced(
    root: Root,
    props: Parameters<typeof AdvancedWorkspace>[0],
): Promise<void> {
    await act(async () => root.render(createElement(AdvancedWorkspace, props)));
}

function selection(
    patch: Partial<RecipeConsoleControlSelection> = {},
): RecipeConsoleControlSelection {
    return {
        controlRunId: URL_STATE.controlRunId,
        distributedRunId: URL_STATE.distributedRunId,
        agentId: URL_STATE.agentId,
        issues: [],
        activeRunContext: { kind: 'none', runs: [] },
        groupContext: {
            source: 'selected-distributed-run',
            group: {
                applicationId: 'selected/app',
                workspaceId: 'selected workspace',
                groupId: 'selected-group',
            },
        },
        boardRows: [],
        boardSummary: {} as RecipeConsoleControlSelection['boardSummary'],
        safeTargetableCount: 0,
        lastKnownTargetableCount: 0,
        ...patch,
    };
}

function categoryLinks(container: HTMLElement, category: string) {
    return container.querySelectorAll(
        `[data-advanced-category="${category}"] [data-advanced-surface-link]`,
    );
}

function headings(container: HTMLElement, selector: string): string[] {
    return [...container.querySelectorAll(selector)]
        .map(node => node.textContent?.trim() ?? '');
}

function surfaceUrl(container: HTMLElement, surfaceId: string): URL {
    const link = container.querySelector<HTMLAnchorElement>(
        `[data-surface-id="${surfaceId}"]`,
    );
    expect(link).not.toBeNull();
    return new URL(link!.href);
}

function contextRow(container: HTMLElement, field: string): HTMLElement {
    const row = container.querySelector<HTMLElement>(
        `[data-context-field="${field}"]`,
    );
    expect(row).not.toBeNull();
    return row!;
}

function utf8Bytes(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}
