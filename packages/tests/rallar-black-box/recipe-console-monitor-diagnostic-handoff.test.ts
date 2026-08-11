// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdvancedRecipeConsoleReturnHref } from
    '../../../apps/rallar-black-box/src/recipe-console/advanced/advanced-legacy-href.ts';
import { MonitorDiagnosticHandoffs } from
    '../../../apps/rallar-black-box/src/recipe-console/monitor/MonitorDiagnosticHandoffs.tsx';
import { MonitorInspector } from
    '../../../apps/rallar-black-box/src/recipe-console/monitor/MonitorInspector.tsx';
import type { MonitorWorkspaceModel } from
    '../../../apps/rallar-black-box/src/recipe-console/monitor/monitor-workspace-model.ts';
import type { RecipeConsoleUrlState } from
    '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';
import type {
    DistributedRunFailureRow,
    DistributedRunRuntimeDiagnosticRow,
} from '../../../packages/shared-test/rallar-bb-test/distributed-run-monitor.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const URL_STATE: RecipeConsoleUrlState = {
    v: 1,
    experience: 'recipe-console',
    view: 'monitor',
    controlRunId: 'stale-control',
    distributedRunId: 'stale-distributed',
    agentId: 'stale-agent',
    recipeId: 'stale-recipe',
    commandId: 'stale-command',
    transport: 'ws',
};

const GROUP = {
    applicationId: 'root/application',
    workspaceId: 'root workspace',
    groupId: 'root-group::\u2067exact\u2069',
} as const;

describe('Recipe Console Monitor diagnostic handoffs', () => {
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

    async function renderHandoffs(
        selectedFailure: DistributedRunFailureRow,
        diagnostics: readonly DistributedRunRuntimeDiagnosticRow[] = [],
        sourceSearch = '',
    ): Promise<void> {
        await act(async () => root.render(createElement(MonitorDiagnosticHandoffs, {
            controlRunId: 'control/root',
            diagnostics,
            distributedRunId: 'distributed root',
            failure: selectedFailure,
            group: GROUP,
            sourceSearch,
            state: URL_STATE,
        })));
    }

    it('maps selected failures to stable deduplicated legacy diagnostic links', async () => {
        const cases: readonly [DistributedRunFailureRow, readonly string[]][] = [
            [failure({ code: 'BAD_AUTH' }), ['Auth', 'WebSocket']],
            [failure({ code: 'RTC_NO_ROUTE' }), ['RTC Diagnostics']],
            [failure({ code: 'MISSING_MEMBER' }), ['Groups/Clients']],
            [failure({ code: 'HTTP_SERVICE_UNAVAILABLE' }), ['Rallar Server']],
        ];
        for (const [selectedFailure, labels] of cases) {
            await renderHandoffs(selectedFailure);
            expect(linkLabels()).toEqual(labels);
            expect(new URL(handoffLinks()[0]!.href).searchParams.has('provider'))
                .toBe(false);
        }

        await renderHandoffs(failure({
            code: 'BAD_AUTH',
            message: 'Missing group; Rallar Server status 503',
        }), [
            diagnostic('selected', 'rallar.browser.rtc.no_route'),
            diagnostic('selected', 'rallar.browser.rtc.no_route'),
        ]);
        expect(linkLabels()).toEqual([
            'Auth',
            'WebSocket',
            'RTC Diagnostics',
            'Groups/Clients',
            'Rallar Server',
        ]);
        expect(new Set(handoffLinks().map(link => link.href)).size).toBe(5);
    });

    it('classifies only diagnostics correlated to the selected failure and omits unknowns', async () => {
        await renderHandoffs(failure({ message: 'Command failed' }), [
            diagnostic('other', 'rallar.browser.auth.ticket_forbidden'),
            diagnostic('other', 'rallar.browser.rtc.no_route'),
            diagnostic('selected', 'rallar.browser.rtc.no_peer'),
        ]);
        expect(linkLabels()).toEqual(['RTC Diagnostics']);

        await renderHandoffs(failure({
            key: 'unknown',
            message: 'A generic route reached an authentic server response',
        }), [diagnostic('other', 'rallar.browser.rtc.no_route')]);
        expect(container.querySelector('[data-monitor-diagnostic-handoffs]'))
            .toBeNull();
    });

    it('uses the exact authoritative run group and selected-failure context in safe links', async () => {
        await renderHandoffs(failure({
            code: 'BAD_AUTH',
            agentId: 'agent/exact',
            recipeId: 'recipe exact',
            commandId: 'command::\u2067exact\u2069',
        }), [], '?' + new URLSearchParams({
            provider: 'browser-rallar',
            applicationId: 'spoof-application',
            workspaceId: 'spoof-workspace',
            groupId: 'spoof-group',
            controlToken: 'control-secret',
            returnTo: 'https://attacker.test/steal',
        }));

        const auth = new URL(handoffLinks()[0]!.getAttribute('href')!, 'https://console.test');
        expect(Object.fromEntries(auth.searchParams)).toEqual({
            experience: 'legacy',
            workspace: 'rallar',
            tab: 'auth',
            legacySurface: 'direct.auth',
            diagnosticContext: '1',
            view: 'monitor',
            provider: 'browser-rallar',
            contextApplicationId: 'root/application',
            contextWorkspaceId: 'root workspace',
            contextGroupId: 'root-group::\u2067exact\u2069',
            controlRunId: 'control/root',
            distributedRunId: 'distributed root',
            agentId: 'agent/exact',
            recipeId: 'recipe exact',
            commandId: 'command::\u2067exact\u2069',
            transport: 'ws',
        });
        expect(auth.search).not.toMatch(/spoof|control-secret|returnTo|attacker/i);
        expect(createAdvancedRecipeConsoleReturnHref(auth.search)).toBe(
            '/?provider=browser-rallar&v=1&experience=recipe-console&view=monitor' +
            '&controlRunId=control%2Froot&distributedRunId=distributed+root' +
            '&agentId=agent%2Fexact&recipeId=recipe+exact' +
            '&commandId=command%3A%3A%E2%81%A7exact%E2%81%A9&transport=ws',
        );

        await renderHandoffs(failure({
            kind: 'run',
            code: 'BAD_AUTH',
            agentId: undefined,
            recipeId: undefined,
            commandId: undefined,
        }));
        const runScoped = new URL(
            handoffLinks()[0]!.getAttribute('href')!,
            'https://console.test',
        );
        expect(runScoped.searchParams.get('controlRunId')).toBe('control/root');
        expect(runScoped.searchParams.get('distributedRunId'))
            .toBe('distributed root');
        for (const staleSelection of ['agentId', 'recipeId', 'commandId']) {
            expect(runScoped.searchParams.has(staleSelection), staleSelection)
                .toBe(false);
        }
    });

    it('renders handoffs only for the selected inspector failure', async () => {
        const auth = failure({ key: 'auth', code: 'BAD_AUTH' });
        const rtc = failure({ key: 'rtc', code: 'RTC_NO_ROUTE' });
        await act(async () => root.render(createElement(MonitorInspector, {
            legacyHref: '/?experience=legacy&tab=runs',
            model: monitorModel([auth, rtc]),
            onSelectEvidence: () => undefined,
            selection: { kind: 'failure', id: 'rtc' },
            sourceSearch: '?provider=simulated',
            urlState: URL_STATE,
        })));

        expect(linkLabels()).toEqual(['RTC Diagnostics']);
        expect(container.textContent).not.toContain('Open Auth');
    });

    it('uses bounded native semantic links without runtime or duplicate monitor ownership', async () => {
        await renderHandoffs(failure({
            code: 'BAD_AUTH',
            message: 'Missing group; Rallar Server status 503',
        }), [diagnostic('selected', 'rallar.browser.rtc.no_route')]);

        const nav = container.querySelector('nav[aria-label="Relevant legacy diagnostics"]');
        expect(nav).not.toBeNull();
        expect(nav?.querySelectorAll('a')).toHaveLength(5);
        expect([...nav!.querySelectorAll('a')].every(link =>
            link instanceof HTMLAnchorElement && !link.hasAttribute('role')
        )).toBe(true);

    });

    function handoffLinks(): HTMLAnchorElement[] {
        return [...container.querySelectorAll<HTMLAnchorElement>(
            '[data-monitor-diagnostic-handoffs] a',
        )];
    }

    function linkLabels(): string[] {
        return handoffLinks().map(link => link.textContent?.trim() ?? '');
    }
});

function failure(
    overrides: Partial<DistributedRunFailureRow> = {},
): DistributedRunFailureRow {
    return {
        kind: 'command',
        key: 'selected',
        message: 'Selected failure',
        agentId: 'agent-a',
        recipeId: 'recipe-a',
        commandId: 'command-a',
        ...overrides,
    };
}

function diagnostic(
    failureKey: string,
    diagnosticTypeId: string,
): DistributedRunRuntimeDiagnosticRow {
    return {
        eventId: `${failureKey}:${diagnosticTypeId}`,
        atEpochMs: 1,
        severity: 'error',
        agentId: 'agent-a',
        commandId: 'command-a',
        topic: diagnosticTypeId,
        diagnosticTypeId,
        message: diagnosticTypeId,
        summary: diagnosticTypeId,
        payloadSummary: '{}',
        correlatedFailureKeys: [failureKey],
    };
}

function monitorModel(
    failures: readonly DistributedRunFailureRow[],
): MonitorWorkspaceModel {
    return {
        source: {
            contextKey: 'monitor-context',
            controlRun: { runId: 'control/root', agents: [] },
            distributedRun: {
                distributedRunId: 'distributed root',
                manifest: { group: GROUP },
            },
            freshness: 'current',
        },
        monitor: {
            distributedRunId: 'distributed root',
            failures,
            runtimeDiagnostics: [],
            agentProgress: [],
            recipeProgress: [],
            timeline: [],
            events: [],
            compositeDrilldowns: [],
            artifact: { status: 'invalid', message: 'No artifact.', fileCount: 0 },
        },
        report: { nextActions: [] },
    } as unknown as MonitorWorkspaceModel;
}
