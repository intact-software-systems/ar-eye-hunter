// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import { resolveRallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type {
    ControlDistributedRunListResponse,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';

import {
    buildLegacyDiagnosticReturnHref,
    parseLegacyDiagnosticContext
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/context/legacy-diagnostic-context.ts';
import {
    deriveDistributedDiagnosticSelection,
    resolveRunManagerRefreshSelection
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/context/legacy-diagnostic-run-selection.ts';
import {
    LegacyDiagnosticContextBar,
    LegacyDiagnosticContextProvider
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/context/LegacyDiagnosticContextBar.tsx';
import { useDistributedRecipeBuilder } from '../../../apps/rallar-black-box/src/legacy/runner/distributed-recipes/use-distributed-recipe-builder.ts';
import { useDistributedRecipesActions } from '../../../apps/rallar-black-box/src/legacy/runner/distributed-recipes/use-distributed-recipes-actions.ts';
import { useDistributedRecipesRemoteState } from '../../../apps/rallar-black-box/src/legacy/runner/distributed-recipes/use-distributed-recipes-remote-state.ts';
import { RunManagerPanel } from '../../../apps/rallar-black-box/src/legacy/runner/run-manager/RunManagerPanel.tsx';
import {
    initialRunnerCommandId,
    selectedRunnerResult,
    useRunnerShellSelectionSync,
    useRunnerShellState
} from '../../../apps/rallar-black-box/src/legacy/runner/shell/use-runner-shell-state.ts';
import type { CommandCenterGlobalValues } from '../../../apps/rallar-black-box/src/legacy/shell/global-context-model.ts';
import { createRuntimeStateFixture } from '../shared-test/rallar-bb-runtime/create-runtime-state-fixture.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const BIDI_AGENT = ' agent/\u202e]returnTo=https://evil.example ';
const DIAGNOSTIC_GLOBAL_VALUES: CommandCenterGlobalValues = {
    apiBaseUrl: 'http://api.test',
    applicationId: 'application-a',
    workspaceId: 'workspace-a',
    clientId: 'client-a',
    sessionId: 'session-a',
    roomId: 'group-a'
};
const DRAFT_ROLLUP: ControlDistributedRunSnapshot['rollup'] = {
    state: 'draft',
    ok: false,
    summary: {
        participants: 0,
        readyParticipants: 0,
        passedParticipants: 0,
        failedParticipants: 0,
        recipes: 0,
        passedRecipes: 0,
        failedRecipes: 0,
        groupAssertions: 0,
        passedGroupAssertions: 0,
        failedGroupAssertions: 0,
        blockingFailures: 0
    },
    failures: []
};

describe('legacy diagnostic context parsing', () => {
    it('ignores bridge-shaped values unless the exact v1 marker is present', () => {
        const absent = parseLegacyDiagnosticContext(
            '?view=monitor&agentId=agent-a&controlRunId=control-a'
        );
        expect(absent).toEqual({
            status: 'absent',
            issues: [],
            omittedIssueCount: 0
        });

        const unsupported = parseLegacyDiagnosticContext(
            '?diagnosticContext=2&view=monitor&agentId=agent-a'
        );
        expect(unsupported.status).toBe('unsupported');
        expect(unsupported.context).toBeUndefined();
        expect(unsupported.issues).toEqual([expect.objectContaining({
            field: 'diagnosticContext',
            code: 'unsupported'
        })]);
    });

    it('accepts only the bounded allow-listed provider and exact bridge fields', () => {
        const parsed = parseLegacyDiagnosticContext(new URLSearchParams({
            experience: 'legacy',
            workspace: 'black-box-runner',
            tab: 'rtc-diagnostics',
            diagnosticContext: '1',
            provider: 'browser-rallar',
            contextApplicationId: 'application/one',
            contextWorkspaceId: 'workspace:one',
            contextGroupId: 'group one',
            controlRunId: 'control/one',
            distributedRunId: 'distributed:one',
            agentId: BIDI_AGENT,
            recipeId: 'recipe?one',
            commandId: 'command#one',
            transport: 'messages.rtc',
            view: 'monitor'
        }).toString());

        expect(parsed).toEqual({
            status: 'ready',
            context: {
                version: 1,
                provider: 'browser-rallar',
                contextApplicationId: 'application/one',
                contextWorkspaceId: 'workspace:one',
                contextGroupId: 'group one',
                controlRunId: 'control/one',
                distributedRunId: 'distributed:one',
                agentId: BIDI_AGENT,
                recipeId: 'recipe?one',
                commandId: 'command#one',
                transport: 'messages.rtc',
                view: 'monitor'
            },
            issues: [],
            omittedIssueCount: 0
        });
        expect(parsed.context).not.toHaveProperty('clientId');
        expect(parsed.context).not.toHaveProperty('principalId');
    });

    it('scrubs secrets, control URLs, return targets, and context aliases', () => {
        const parsed = parseLegacyDiagnosticContext(
            '?diagnosticContext=1&view=monitor&agentId=agent-a' +
                '&token=secret&controlToken=secret-two&agentSessionTicket=ticket' +
                '&controlUrl=https%3A%2F%2Fcontrol.example' +
                '&returnTo=https%3A%2F%2Fevil.example%2Fsteal' +
                '&applicationId=alias-app&workspaceId=alias-workspace' +
                '&groupId=alias-group&clientId=agent-a&principalId=agent-a'
        );

        expect(parsed.status).toBe('ready');
        expect(parsed.context).toEqual({
            version: 1,
            agentId: 'agent-a',
            view: 'monitor'
        });
        expect(parsed.issues.map((issue) => issue.field)).toEqual(expect.arrayContaining([
            'token',
            'controlToken',
            'agentSessionTicket',
            'controlUrl',
            'returnTo',
            'applicationId',
            'workspaceId',
            'groupId',
            'clientId',
            'principalId'
        ]));
        expect(JSON.stringify(parsed)).not.toContain('secret-two');
        expect(JSON.stringify(parsed)).not.toContain('evil.example');
        expect(JSON.stringify(parsed)).not.toContain('alias-app');
    });

    it('rejects duplicate, malformed, invalid, control-bearing, and overlong values', () => {
        const overlong = '🧭'.repeat(1_025);
        const parsed = parseLegacyDiagnosticContext(
            '?diagnosticContext=1' +
                '&provider=filesystem' +
                '&view=monitor&view=analyze' +
                '&agentId=first&agentId=second' +
                '&recipeId=%E0%A4%A' +
                '&commandId=line%0Abreak' +
                `&contextGroupId=${encodeURIComponent(overlong)}` +
                '&transport=peer-text'
        );

        expect(parsed.status).toBe('ready');
        expect(parsed.context).toEqual({ version: 1 });
        expect(parsed.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'provider', code: 'invalid' }),
            expect.objectContaining({ field: 'view', code: 'duplicate' }),
            expect.objectContaining({ field: 'agentId', code: 'duplicate' }),
            expect.objectContaining({ field: 'recipeId', code: 'malformed' }),
            expect.objectContaining({ field: 'commandId', code: 'invalid' }),
            expect.objectContaining({ field: 'contextGroupId', code: 'overlong' }),
            expect.objectContaining({ field: 'transport', code: 'invalid' })
        ]));

        const duplicateMarker = parseLegacyDiagnosticContext(
            '?diagnosticContext=1&diagnosticContext=1&view=monitor'
        );
        expect(duplicateMarker.status).toBe('invalid');
        expect(duplicateMarker.context).toBeUndefined();
    });

    it('keeps issue evidence bounded without retaining forbidden values', () => {
        const params = new URLSearchParams({ diagnosticContext: '1' });
        for (let index = 0; index < 80; index += 1) {
            params.append('returnTo', `https://evil.example/${index}`);
        }
        const parsed = parseLegacyDiagnosticContext(params.toString());
        expect(parsed.issues.length).toBeLessThanOrEqual(32);
        expect(parsed.omittedIssueCount).toBeGreaterThan(0);
        expect(JSON.stringify(parsed)).not.toContain('evil.example');
    });
});

describe('legacy diagnostic return URL', () => {
    it('structurally restores Recipe Console v1 selection without bridge or legacy keys', () => {
        const parsed = parseLegacyDiagnosticContext(new URLSearchParams({
            diagnosticContext: '1',
            provider: 'simulated',
            contextApplicationId: 'application-a',
            contextWorkspaceId: 'workspace-a',
            contextGroupId: 'group-a',
            controlRunId: 'control/a',
            distributedRunId: 'distributed?a',
            agentId: BIDI_AGENT,
            recipeId: 'recipe#a',
            commandId: 'command a',
            transport: 'rtc',
            view: 'monitor',
            returnTo: 'https://evil.example',
            token: 'secret',
            workspace: 'black-box-runner',
            tab: 'websocket'
        }).toString());
        const href = buildLegacyDiagnosticReturnHref(parsed.context);

        expect(href).toBe(
            '/?provider=simulated&v=1&experience=recipe-console&view=monitor' +
                '&controlRunId=control%2Fa&distributedRunId=distributed%3Fa' +
                '&agentId=+agent%2F%E2%80%AE%5DreturnTo%3Dhttps%3A%2F%2F' +
                'evil.example+' +
                '&recipeId=recipe%23a&commandId=command+a&transport=rtc'
        );
        const url = new URL(href ?? '', 'https://app.example');
        expect(url.origin).toBe('https://app.example');
        for (
            const forbidden of [
                'diagnosticContext',
                'contextApplicationId',
                'contextWorkspaceId',
                'contextGroupId',
                'workspace',
                'tab',
                'advanced',
                'advancedSurface',
                'returnTo',
                'token',
                'controlUrl'
            ]
        ) {
            expect(url.searchParams.has(forbidden), forbidden).toBe(false);
        }
    });

    it('returns no link without a supported source view or with an invalid raw selection', () => {
        expect(buildLegacyDiagnosticReturnHref({ version: 1 }))
            .toBeUndefined();
        const parsed = parseLegacyDiagnosticContext(new URLSearchParams({
            diagnosticContext: '1',
            view: 'https://evil.example',
            provider: 'https://evil.example',
            controlRunId: 'https://evil.example/steal'
        }).toString());
        expect(buildLegacyDiagnosticReturnHref(parsed.context)).toBeUndefined();
    });
});

describe('LegacyDiagnosticContextBar', () => {
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

    async function render(search: string) {
        const parsed = parseLegacyDiagnosticContext(search);
        await act(async () =>
            root.render(createElement(
                LegacyDiagnosticContextBar,
                { parsed }
            ))
        );
        return parsed;
    }

    it('shows exact isolated context and a structural return anchor', async () => {
        const locationBeforeRender = window.location.href;
        await render(new URLSearchParams({
            diagnosticContext: '1',
            provider: 'browser-rallar',
            contextApplicationId: 'app-a',
            contextWorkspaceId: 'workspace-a',
            contextGroupId: 'group-a',
            controlRunId: 'control-a',
            distributedRunId: 'distributed-a',
            agentId: BIDI_AGENT,
            recipeId: 'recipe-a',
            commandId: 'command-a',
            transport: 'ws',
            view: 'monitor'
        }).toString());

        const owner = container.querySelector('[data-legacy-diagnostic-context]');
        expect(owner?.getAttribute('data-context-status')).toBe('ready');
        expect(owner?.textContent).toContain('Recipe Console diagnostic context');
        expect(owner?.textContent).toContain('Context only; not a client identity.');
        const values = [
            ...owner?.querySelectorAll(
                '[data-legacy-diagnostic-context-value]'
            ) ?? []
        ];
        expect(values.some((node) => node.textContent === BIDI_AGENT)).toBe(true);
        expect(values.every((node) => node.getAttribute('dir') === 'ltr')).toBe(true);
        const agentRow = owner?.querySelector('[data-context-field="agentId"]');
        expect(agentRow?.textContent).toContain('Agent');
        expect(agentRow?.textContent).not.toContain('Client');
        expect(agentRow?.textContent).not.toContain('Principal');

        const returnAnchor = owner?.querySelector<HTMLAnchorElement>(
            '[data-legacy-diagnostic-return]'
        );
        expect(returnAnchor?.textContent).toBe('Return to Monitor');
        expect(returnAnchor?.getAttribute('href')).toContain(
            '/?provider=browser-rallar&v=1&experience=recipe-console&view=monitor'
        );
        expect(window.location.href).toBe(locationBeforeRender);
    });

    it('states absent, unsupported, and missing-return context honestly', async () => {
        await render('?workspace=rallar&tab=auth');
        expect(container.textContent).toContain('No Recipe Console diagnostic context');
        expect(container.querySelector('[data-legacy-diagnostic-return]')).toBeNull();

        await render('?diagnosticContext=9&view=monitor');
        expect(container.textContent).toContain('Unsupported diagnostic context');
        expect(container.querySelector('[data-legacy-diagnostic-return]')).toBeNull();

        await render('?diagnosticContext=1&agentId=agent-a');
        expect(container.textContent).toContain('Return link unavailable');
        expect(container.querySelector('[data-legacy-diagnostic-return]')).toBeNull();
    });
});

describe('legacy diagnostic context consumers', () => {
    const context = parseLegacyDiagnosticContext(
        '?diagnosticContext=1&view=monitor&controlRunId=control-context' +
            '&distributedRunId=distributed-context&commandId=command-context' +
            '&agentId=agent-display-only'
    ).context;

    it('makes command context the actual exact selection without falling back', () => {
        const history = [{
            commandId: 'command-other',
            kind: 'health',
            status: 'ok',
            ok: true,
            startedAtEpochMs: 1,
            endedAtEpochMs: 2,
            durationMs: 1
        }] as const;

        expect(initialRunnerCommandId(context, 'stored-command'))
            .toBe('command-context');
        expect(selectedRunnerResult(history, 'command-context', context))
            .toBeUndefined();
        expect(initialRunnerCommandId(undefined, 'stored-command'))
            .toBe('stored-command');
        expect(selectedRunnerResult(history, undefined, undefined))
            .toBe(history[0]);
    });

    it('uses command context initially and on context change without locking user selection', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const state = createRuntimeStateFixture();

        function Harness({ commandId }: { commandId: string; }) {
            const selection = useRunnerShellState(state, {
                version: 1,
                commandId
            });
            useRunnerShellSelectionSync(selection);
            return createElement('button', {
                type: 'button',
                onClick: () => selection.setSelectedCommandId('manual-command')
            }, selection.selectedCommandId);
        }

        await act(async () =>
            root.render(createElement(Harness, {
                commandId: 'context-command-a'
            }))
        );
        const button = container.querySelector('button');
        expect(button?.textContent).toBe('context-command-a');
        await act(async () => button?.click());
        expect(button?.textContent).toBe('manual-command');
        await act(async () =>
            root.render(createElement(Harness, {
                commandId: 'context-command-a'
            }))
        );
        expect(button?.textContent).toBe('manual-command');
        await act(async () =>
            root.render(createElement(Harness, {
                commandId: 'context-command-b'
            }))
        );
        expect(button?.textContent).toBe('context-command-b');

        await act(async () => root.unmount());
        container.remove();
    });

    it('follows the manually selected result after consuming command context', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const state = {
            ...createRuntimeStateFixture(),
            commandHistory: [{
                commandId: 'context-command',
                kind: 'health',
                status: 'ok',
                ok: true,
                startedAtEpochMs: 1,
                endedAtEpochMs: 2,
                durationMs: 1
            }, {
                commandId: 'manual-command',
                kind: 'health',
                status: 'ok',
                ok: true,
                startedAtEpochMs: 3,
                endedAtEpochMs: 4,
                durationMs: 1
            }]
        } as const;

        function Harness() {
            const selection = useRunnerShellState(state, {
                version: 1,
                commandId: 'context-command'
            });
            useRunnerShellSelectionSync(selection);
            return createElement('button', {
                type: 'button',
                onClick: () => selection.setSelectedCommandId('manual-command')
            }, `${selection.selectedCommandId}:${selection.selectedResult?.commandId}`);
        }

        await act(async () => root.render(createElement(Harness)));
        const button = container.querySelector('button');
        expect(button?.textContent).toBe('context-command:context-command');
        await act(async () => button?.click());
        expect(button?.textContent).toBe('manual-command:manual-command');

        await act(async () => root.unmount());
        container.remove();
    });

    it('protects diagnostic command input from an already-active command while preserving later choices', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);

        function Harness({
            activeCommandId,
            commandId
        }: {
            activeCommandId: string;
            commandId: string;
        }) {
            const selection = useRunnerShellState({
                ...createRuntimeStateFixture(),
                status: 'running',
                activeCommand: {
                    commandId: activeCommandId,
                    kind: 'health'
                }
            }, {
                version: 1,
                commandId
            });
            useRunnerShellSelectionSync(selection);
            return createElement('button', {
                type: 'button',
                onClick: () => selection.setSelectedCommandId('manual-command')
            }, selection.selectedCommandId);
        }

        await act(async () =>
            root.render(createElement(Harness, {
                activeCommandId: 'active-command-a',
                commandId: 'context-command-a'
            }))
        );
        const button = container.querySelector('button');
        expect(button?.textContent).toBe('context-command-a');

        await act(async () => button?.click());
        expect(button?.textContent).toBe('manual-command');

        await act(async () =>
            root.render(createElement(Harness, {
                activeCommandId: 'active-command-a',
                commandId: 'context-command-b'
            }))
        );
        expect(button?.textContent).toBe('context-command-b');

        await act(async () => button?.click());
        expect(button?.textContent).toBe('manual-command');

        await act(async () =>
            root.render(createElement(Harness, {
                activeCommandId: 'active-command-b',
                commandId: 'context-command-b'
            }))
        );
        expect(button?.textContent).toBe('active-command-b');

        await act(async () => root.unmount());
        container.remove();
    });

    it('selects the exact Run Manager context and never substitutes a stale ID', () => {
        expect(resolveRunManagerRefreshSelection({
            preferredRunId: 'control-context',
            diagnosticControlRunId: 'control-context',
            controlRunId: 'control-live',
            bootstrapRunId: 'control-bootstrap',
            availableRunIds: [
                'control-live',
                'control-context',
                'control-bootstrap'
            ]
        })).toEqual({ runId: 'control-context' });

        expect(resolveRunManagerRefreshSelection({
            preferredRunId: 'control-context',
            diagnosticControlRunId: 'control-context',
            controlRunId: 'control-live',
            bootstrapRunId: 'control-bootstrap',
            availableRunIds: ['control-live', 'control-bootstrap']
        })).toEqual({
            runId: '',
            issue: 'Requested diagnostic control run is unavailable. No substitute was selected.'
        });

        expect(resolveRunManagerRefreshSelection({
            preferredRunId: '',
            diagnosticControlRunId: 'control-context',
            controlRunId: 'control-live',
            bootstrapRunId: 'control-bootstrap',
            availableRunIds: ['control-live', 'control-bootstrap']
        })).toEqual({
            runId: '',
            issue: 'Requested diagnostic control run is unavailable. No substitute was selected.'
        });

        expect(resolveRunManagerRefreshSelection({
            preferredRunId: '',
            controlRunId: 'control-live',
            bootstrapRunId: 'control-bootstrap',
            availableRunIds: ['control-live', 'control-bootstrap']
        })).toEqual({ runId: 'control-live' });
    });

    it('accepts only an exact available distributed pair and reports stale context', () => {
        const runs = [{
            controlRunId: 'control-context',
            distributedRunId: 'distributed-context'
        }, {
            controlRunId: 'control-other',
            distributedRunId: 'distributed-other'
        }];
        expect(deriveDistributedDiagnosticSelection({
            requestedControlRunId: 'control-context',
            requestedDistributedRunId: 'distributed-context',
            availableControlRunIds: ['control-context', 'control-other'],
            distributedRuns: runs
        })).toEqual({
            controlRunId: 'control-context',
            distributedRunId: 'distributed-context'
        });
        expect(deriveDistributedDiagnosticSelection({
            requestedControlRunId: 'control-missing',
            requestedDistributedRunId: 'distributed-context',
            availableControlRunIds: ['control-context'],
            distributedRuns: runs
        })).toEqual({
            controlRunId: '',
            issue: 'Requested diagnostic control run is unavailable. No substitute was selected.'
        });
        expect(deriveDistributedDiagnosticSelection({
            requestedControlRunId: 'control-context',
            requestedDistributedRunId: 'distributed-other',
            availableControlRunIds: ['control-context', 'control-other'],
            distributedRuns: runs
        })).toEqual({
            controlRunId: 'control-context',
            issue: 'Requested diagnostic distributed run does not belong to the requested control run.'
        });
    });
});

describe('legacy diagnostic async selection authority', () => {
    let container: HTMLDivElement;
    let root: Root;
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        globalThis.fetch = originalFetch;
    });

    it('keeps stale distributed context honest until a valid manual pair replaces it', async () => {
        const run = createControlRunSnapshot('control-valid', 30);
        const distributed = createDistributedRunSnapshot(
            'distributed-valid',
            'control-valid',
            30
        );
        globalThis.fetch = async (input) => {
            const pathname = new URL(String(input)).pathname;
            if (pathname === '/runs') {
                return createJsonResponse({ runs: [run] });
            }
            if (pathname === '/distributed-runs') {
                return createJsonResponse({ distributedRuns: [distributed] });
            }
            if (pathname === '/distributed-runs/distributed-valid') {
                return createJsonResponse(distributed);
            }
            if (pathname === '/runs/control-valid') {
                return createJsonResponse(run);
            }
            throw new Error(`Unexpected request: ${pathname}`);
        };

        let observed: ReturnType<typeof useDistributedRecipesRemoteState> | undefined;
        let manifestValidation: string | undefined;
        let loadValidPair: (() => Promise<void>) | undefined;

        function Harness() {
            const remoteFixture = createDistributedRemoteFixture({
                initialControlRunId: 'control-missing',
                initialDistributedRunId: 'distributed-missing'
            });
            const remote = useDistributedRecipesRemoteState(remoteFixture);
            const builder = useDistributedRecipeBuilder({
                globalValues: DIAGNOSTIC_GLOBAL_VALUES,
                selectedRunId: remote.selectedRunId,
                run: remote.run,
                distributedRuns: remote.distributedRuns,
                selectedDistributedRun: remote.selectedDistributedRun,
                targetResolutionPreview: remote.targetResolutionPreview,
                monitorAgentProgress: remote.selectedMonitor?.agentProgress,
                initialDistributedRunId: 'distributed-missing',
                diagnosticSelectionIssue: remote.diagnosticSelectionIssue
            });
            const actions = useDistributedRecipesActions({
                bootstrap: remoteFixture.bootstrap,
                control: remoteFixture.control,
                roomId: 'group-a',
                remote,
                builder
            });
            observed = remote;
            manifestValidation = builder.manifestValidation;
            loadValidPair = () => actions.loadDistributedRun('distributed-valid');
            return createElement(
                'output',
                null,
                `${remote.diagnosticSelectionIssue ?? 'clear'}|` +
                    `${remote.selectedRunId}|` +
                    `${remote.selectedDistributedRun?.distributedRunId ?? 'none'}`
            );
        }

        await act(async () => {
            root.render(createElement(Harness));
            await flushAsyncWork();
        });
        expect(observed?.diagnosticSelectionIssue).toContain(
            'Requested diagnostic control run is unavailable'
        );
        expect(manifestValidation).toContain(
            'Requested diagnostic control run is unavailable'
        );

        await act(async () => {
            await loadValidPair?.();
            await flushAsyncWork();
        });
        expect(observed?.diagnosticSelectionIssue).toBeUndefined();
        expect(observed?.selectedRunId).toBe('control-valid');
        expect(observed?.selectedDistributedRun?.distributedRunId)
            .toBe('distributed-valid');
        expect(manifestValidation).not.toContain('Requested diagnostic');
    });

    it('keeps the newest Run Manager context when an older manual load resolves last', async () => {
        const contextA = createControlRunSnapshot('control-context-a', 10);
        const contextB = createControlRunSnapshot('control-context-b', 30);
        const oldManual = createControlRunSnapshot('control-manual-old', 20);
        const oldResponse = Promise.withResolvers<Response>();
        globalThis.fetch = async (input) => {
            const pathname = new URL(String(input)).pathname;
            if (pathname === '/runs') {
                return createJsonResponse({ runs: [contextB, oldManual, contextA] });
            }
            if (pathname === '/runs/control-context-a') {
                return createJsonResponse(contextA);
            }
            if (pathname === '/runs/control-context-b') {
                return createJsonResponse(contextB);
            }
            if (pathname === '/runs/control-manual-old') {
                return oldResponse.promise;
            }
            throw new Error(`Unexpected request: ${pathname}`);
        };

        const renderContext = async (controlRunId: string) => {
            await act(async () => {
                root.render(createElement(LegacyDiagnosticContextProvider, {
                    parsed: createDiagnosticContextFixture(controlRunId),
                    children: createElement(RunManagerPanel, createRunManagerProps())
                }));
                await flushAsyncWork();
            });
        };

        await renderContext('control-context-a');
        const oldButton = [...container.querySelectorAll<HTMLButtonElement>(
            '.run-manager-run-row'
        )].find((button) => button.textContent?.includes('control-manual-old'));
        expect(oldButton).toBeDefined();
        await act(async () => {
            oldButton?.click();
            await Promise.resolve();
        });

        await renderContext('control-context-b');
        expect(getRunManagerTelemetryRunId(container)).toBe('control-context-b');

        await act(async () => {
            oldResponse.resolve(createJsonResponse(oldManual));
            await flushAsyncWork();
        });
        expect(getRunManagerTelemetryRunId(container)).toBe('control-context-b');
    });

    it('keeps a newer distributed load when an older refresh resolves last', async () => {
        const initial = createControlRunSnapshot('control-initial', 10);
        const old = createControlRunSnapshot('control-old', 20);
        const newest = createControlRunSnapshot('control-new', 30);
        const oldDistributed = createDistributedRunSnapshot(
            'distributed-old',
            'control-old',
            20
        );
        const newestDistributed = createDistributedRunSnapshot(
            'distributed-new',
            'control-new',
            30
        );
        const oldServerResponse = Promise.withResolvers<Response>();
        const oldDistributedResponse = Promise.withResolvers<Response>();
        let racing = false;
        globalThis.fetch = async (input) => {
            const pathname = new URL(String(input)).pathname;
            if (pathname === '/runs') {
                return racing
                    ? oldServerResponse.promise
                    : createJsonResponse({ runs: [initial, old, newest] });
            }
            if (pathname === '/distributed-runs') {
                return racing
                    ? oldDistributedResponse.promise
                    : createJsonResponse({ distributedRuns: [] });
            }
            if (pathname === '/runs/control-initial') {
                return createJsonResponse(initial);
            }
            if (pathname === '/runs/control-old') {
                return createJsonResponse(old);
            }
            if (pathname === '/runs/control-new') {
                return createJsonResponse(newest);
            }
            if (pathname === '/distributed-runs/distributed-new') {
                return createJsonResponse(newestDistributed);
            }
            throw new Error(`Unexpected request: ${pathname}`);
        };

        let observed: ReturnType<typeof useDistributedRecipesRemoteState> | undefined;
        let actions: ReturnType<typeof useDistributedRecipesActions> | undefined;

        function Harness() {
            const remoteFixture = createDistributedRemoteFixture({});
            const remote = useDistributedRecipesRemoteState(remoteFixture);
            const builder = useDistributedRecipeBuilder({
                globalValues: DIAGNOSTIC_GLOBAL_VALUES,
                selectedRunId: remote.selectedRunId,
                run: remote.run,
                distributedRuns: remote.distributedRuns,
                selectedDistributedRun: remote.selectedDistributedRun,
                targetResolutionPreview: remote.targetResolutionPreview,
                monitorAgentProgress: remote.selectedMonitor?.agentProgress,
                initialDistributedRunId: 'distributed-initial',
                diagnosticSelectionIssue: remote.diagnosticSelectionIssue
            });
            observed = remote;
            actions = useDistributedRecipesActions(
                {
                    bootstrap: remoteFixture.bootstrap,
                    control: remoteFixture.control,
                    roomId: 'group-a',
                    remote,
                    builder
                }
            );
            return createElement(
                'output',
                null,
                `${remote.selectedRunId}|` +
                    `${remote.selectedDistributedRun?.distributedRunId ?? 'none'}`
            );
        }

        await act(async () => {
            root.render(createElement(Harness));
            await flushAsyncWork();
        });
        expect(observed?.selectedRunId).toBe('control-initial');

        racing = true;
        let staleRefresh: Promise<void> | undefined;
        await act(async () => {
            staleRefresh = actions?.refresh('control-old', 'distributed-old');
            await Promise.resolve();
        });
        await act(async () => {
            await actions?.loadDistributedRun('distributed-new');
            await flushAsyncWork();
        });
        expect(observed?.selectedRunId).toBe('control-new');
        expect(observed?.selectedDistributedRun?.distributedRunId)
            .toBe('distributed-new');

        await act(async () => {
            oldServerResponse.resolve(createJsonResponse({ runs: [old] }));
            oldDistributedResponse.resolve(createJsonResponse({
                distributedRuns: [oldDistributed]
            }));
            await staleRefresh;
            await flushAsyncWork();
        });
        expect(observed?.selectedRunId).toBe('control-new');
        expect(observed?.selectedDistributedRun?.distributedRunId)
            .toBe('distributed-new');
    });

    it('lets a blank Run Manager selection own and clear a pending refresh', async () => {
        const initial = createControlRunSnapshot('control-initial', 10);
        const stale = createControlRunSnapshot('control-stale', 20);
        const staleRefresh = Promise.withResolvers<Response>();
        let refreshPending = false;
        globalThis.fetch = async (input) => {
            const pathname = new URL(String(input)).pathname;
            if (pathname === '/runs') {
                return refreshPending
                    ? staleRefresh.promise
                    : createJsonResponse({ runs: [initial] });
            }
            if (pathname === '/runs/control-initial') {
                return createJsonResponse(initial);
            }
            throw new Error(`Unexpected request: ${pathname}`);
        };

        await act(async () => {
            root.render(createElement(RunManagerPanel, createRunManagerProps()));
            await flushAsyncWork();
        });
        expect(getRunManagerTelemetryRunId(container)).toBe('control-initial');

        refreshPending = true;
        const refreshButton = [...container.querySelectorAll<HTMLButtonElement>(
            'button'
        )].find((button) => button.textContent?.trim() === 'Refresh');
        const runSelect = container.querySelector<HTMLSelectElement>(
            '.run-manager-toolbar select'
        );
        expect(refreshButton).toBeDefined();
        expect(runSelect).toBeDefined();
        await act(async () => {
            refreshButton?.click();
            await Promise.resolve();
        });
        expect(refreshButton?.disabled).toBe(true);

        await act(async () => {
            if (runSelect) {
                runSelect.value = '';
                runSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }
            await Promise.resolve();
        });
        expect(runSelect?.value).toBe('');
        expect(getRunManagerTelemetryRunId(container)).toBe('no run');
        expect(refreshButton?.disabled).toBe(false);
        expect(container.querySelector('.run-manager-error')).toBeNull();

        await act(async () => {
            staleRefresh.resolve(createJsonResponse({ runs: [stale] }));
            await flushAsyncWork();
        });
        expect(runSelect?.value).toBe('');
        expect(getRunManagerTelemetryRunId(container)).toBe('no run');
        expect(refreshButton?.disabled).toBe(false);
        expect(container.querySelector('.run-manager-error')).toBeNull();
    });

    it('lets a blank Distributed selection own and clear a pending refresh', async () => {
        const initial = createControlRunSnapshot('control-initial', 10);
        const stale = createControlRunSnapshot('control-stale', 20);
        const staleRefresh = Promise.withResolvers<Response>();
        let refreshPending = false;
        globalThis.fetch = async (input) => {
            const pathname = new URL(String(input)).pathname;
            if (pathname === '/runs') {
                return refreshPending
                    ? staleRefresh.promise
                    : createJsonResponse({ runs: [initial] });
            }
            if (pathname === '/distributed-runs') {
                return createJsonResponse({ distributedRuns: [] });
            }
            if (pathname === '/runs/control-initial') {
                return createJsonResponse(initial);
            }
            throw new Error(`Unexpected request: ${pathname}`);
        };

        let observed: ReturnType<typeof useDistributedRecipesRemoteState> | undefined;

        function Harness() {
            const remoteFixture = createDistributedRemoteFixture({});
            const remote = useDistributedRecipesRemoteState(remoteFixture);
            const builder = useDistributedRecipeBuilder({
                globalValues: DIAGNOSTIC_GLOBAL_VALUES,
                selectedRunId: remote.selectedRunId,
                run: remote.run,
                distributedRuns: remote.distributedRuns,
                selectedDistributedRun: remote.selectedDistributedRun,
                targetResolutionPreview: remote.targetResolutionPreview,
                monitorAgentProgress: remote.selectedMonitor?.agentProgress,
                initialDistributedRunId: 'distributed-initial',
                diagnosticSelectionIssue: remote.diagnosticSelectionIssue
            });
            const actions = useDistributedRecipesActions(
                {
                    bootstrap: remoteFixture.bootstrap,
                    control: remoteFixture.control,
                    roomId: 'group-a',
                    remote,
                    builder
                }
            );
            observed = remote;
            return createElement(
                'div',
                null,
                createElement('button', {
                    type: 'button',
                    onClick: () => void actions.refresh(),
                    'data-refresh': true
                }, 'Refresh'),
                createElement('button', {
                    type: 'button',
                    onClick: () => void actions.loadRun(''),
                    'data-clear': true
                }, 'Clear')
            );
        }

        await act(async () => {
            root.render(createElement(Harness));
            await flushAsyncWork();
        });
        expect(observed?.run?.runId).toBe('control-initial');

        refreshPending = true;
        await act(async () => {
            container.querySelector<HTMLButtonElement>('[data-refresh]')?.click();
            await Promise.resolve();
        });
        expect(observed?.busyAction).toBe('refresh');

        await act(async () => {
            container.querySelector<HTMLButtonElement>('[data-clear]')?.click();
            await Promise.resolve();
        });
        expect(observed?.busyAction).toBeUndefined();
        expect(observed?.error).toBeUndefined();
        expect(observed?.selectedRunId).toBe('');
        expect(observed?.run).toBeUndefined();

        await act(async () => {
            staleRefresh.resolve(createJsonResponse({ runs: [stale] }));
            await flushAsyncWork();
        });
        expect(observed?.busyAction).toBeUndefined();
        expect(observed?.error).toBeUndefined();
        expect(observed?.selectedRunId).toBe('');
        expect(observed?.run).toBeUndefined();
    });
});

function createJsonResponse(
    value: ControlServerSnapshot | ControlDistributedRunListResponse | ControlRunSnapshot | ControlDistributedRunSnapshot
): Response {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}

async function flushAsyncWork(): Promise<void> {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function createControlRunSnapshot(runId: string, updatedAtEpochMs: number): ControlRunSnapshot {
    return {
        runId,
        createdAtEpochMs: 1,
        updatedAtEpochMs,
        agents: [],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: []
    } as const;
}

function createDistributedRunSnapshot(
    distributedRunId: string,
    controlRunId: string,
    updatedAtEpochMs: number
): ControlDistributedRunSnapshot {
    return {
        distributedRunId,
        controlRunId,
        manifest: {
            schemaVersion: 1,
            distributedRunId,
            controlRunId,
            group: {
                applicationId: 'application-a',
                workspaceId: 'workspace-a',
                groupId: 'group-a'
            },
            recipes: [{ recipeId: 'recipe-a', variables: {} }],
            targetPolicy: {
                mode: 'selected-agents',
                agentIds: ['agent-a']
            },
            variables: {},
            roleAssignments: [],
            ackTimeoutMs: 30_000,
            barrier: { enabled: false },
            startMode: 'manual',
            groupAssertions: [],
            metadata: {}
        },
        state: 'draft',
        createdAtEpochMs: 1,
        updatedAtEpochMs,
        targetAgentIds: [],
        commandLinks: [],
        rollup: DRAFT_ROLLUP
    } as const;
}

function createDistributedRemoteFixture({
    initialControlRunId,
    initialDistributedRunId
}: Pick<Parameters<typeof useDistributedRecipesRemoteState>[0], 'initialControlRunId' | 'initialDistributedRunId'>): Parameters<
    typeof useDistributedRecipesRemoteState
>[0] {
    return {
        state: createRuntimeStateFixture(),
        bootstrap: resolveRallarBlackBoxBootstrapConfig(
            '?controlUrl=ws%3A%2F%2Fcontrol.test%2Fcontrol&runId=control-initial',
            {},
            ''
        ),
        control: {
            state: 'registered',
            url: 'ws://control.test/control',
            runId: 'control-initial',
            reconnectAttempt: 0,
            sentCount: 0,
            receivedCount: 0
        },
        initialControlRunId,
        initialDistributedRunId
    };
}

function createDiagnosticContextFixture(controlRunId: string): ReturnType<typeof parseLegacyDiagnosticContext> {
    return parseLegacyDiagnosticContext(new URLSearchParams({
        diagnosticContext: '1',
        controlRunId
    }).toString());
}

function createRunManagerProps(): Parameters<typeof RunManagerPanel>[0] {
    return {
        state: createRuntimeStateFixture(),
        bootstrap: resolveRallarBlackBoxBootstrapConfig(
            '?controlUrl=ws%3A%2F%2Fcontrol.test%2Fcontrol',
            {},
            ''
        ),
        control: {
            state: 'registered',
            url: 'ws://control.test/control',
            reconnectAttempt: 0,
            sentCount: 0,
            receivedCount: 0
        }
    };
}

function getRunManagerTelemetryRunId(container: HTMLElement): string | null {
    return container.querySelector(
        '.run-manager-telemetry-panel .section-heading span'
    )?.textContent ?? null;
}
