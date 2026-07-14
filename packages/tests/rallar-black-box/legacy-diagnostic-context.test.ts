// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    buildLegacyDiagnosticReturnHref,
    parseLegacyDiagnosticContext,
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/context/legacy-diagnostic-context.ts';
import { LegacyDiagnosticContextBar } from
    '../../../apps/rallar-black-box/src/legacy/diagnostics/context/LegacyDiagnosticContextBar.tsx';
import {
    initialRunnerCommandId,
    selectedRunnerResult,
    useRunnerShellSelectionSync,
    useRunnerShellState,
} from '../../../apps/rallar-black-box/src/legacy/runner/shell/use-runner-shell-state.ts';
import {
    resolveRunManagerRefreshSelection,
    deriveDistributedDiagnosticSelection,
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/context/legacy-diagnostic-run-selection.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE_ROOT = 'apps/rallar-black-box/src/legacy/diagnostics/context';
const BIDI_AGENT = ' agent/\u202e]returnTo=https://evil.example ';

describe('legacy diagnostic context parsing', () => {
    it('ignores bridge-shaped values unless the exact v1 marker is present', () => {
        const absent = parseLegacyDiagnosticContext(
            '?view=monitor&agentId=agent-a&controlRunId=control-a',
        );
        expect(absent).toEqual({
            status: 'absent',
            issues: [],
            omittedIssueCount: 0,
        });

        const unsupported = parseLegacyDiagnosticContext(
            '?diagnosticContext=2&view=monitor&agentId=agent-a',
        );
        expect(unsupported.status).toBe('unsupported');
        expect(unsupported.context).toBeUndefined();
        expect(unsupported.issues).toEqual([expect.objectContaining({
            field: 'diagnosticContext',
            code: 'unsupported',
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
            view: 'monitor',
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
                view: 'monitor',
            },
            issues: [],
            omittedIssueCount: 0,
        });
        expect(parsed.context).not.toHaveProperty('clientId');
        expect(parsed.context).not.toHaveProperty('principalId');
    });

    it('scrubs secrets, control URLs, return targets, and context aliases', () => {
        const parsed = parseLegacyDiagnosticContext(
            '?diagnosticContext=1&view=monitor&agentId=agent-a'
            + '&token=secret&controlToken=secret-two&agentSessionTicket=ticket'
            + '&controlUrl=https%3A%2F%2Fcontrol.example'
            + '&returnTo=https%3A%2F%2Fevil.example%2Fsteal'
            + '&applicationId=alias-app&workspaceId=alias-workspace'
            + '&groupId=alias-group&clientId=agent-a&principalId=agent-a',
        );

        expect(parsed.status).toBe('ready');
        expect(parsed.context).toEqual({
            version: 1,
            agentId: 'agent-a',
            view: 'monitor',
        });
        expect(parsed.issues.map(issue => issue.field)).toEqual(expect.arrayContaining([
            'token',
            'controlToken',
            'agentSessionTicket',
            'controlUrl',
            'returnTo',
            'applicationId',
            'workspaceId',
            'groupId',
            'clientId',
            'principalId',
        ]));
        expect(JSON.stringify(parsed)).not.toContain('secret-two');
        expect(JSON.stringify(parsed)).not.toContain('evil.example');
        expect(JSON.stringify(parsed)).not.toContain('alias-app');
    });

    it('rejects duplicate, malformed, invalid, control-bearing, and overlong values', () => {
        const overlong = '🧭'.repeat(1_025);
        const parsed = parseLegacyDiagnosticContext(
            '?diagnosticContext=1'
            + '&provider=filesystem'
            + '&view=monitor&view=analyze'
            + '&agentId=first&agentId=second'
            + '&recipeId=%E0%A4%A'
            + '&commandId=line%0Abreak'
            + `&contextGroupId=${encodeURIComponent(overlong)}`
            + '&transport=peer-text',
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
            expect.objectContaining({ field: 'transport', code: 'invalid' }),
        ]));

        const duplicateMarker = parseLegacyDiagnosticContext(
            '?diagnosticContext=1&diagnosticContext=1&view=monitor',
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
            tab: 'websocket',
        }).toString());
        const href = buildLegacyDiagnosticReturnHref(parsed.context);

        expect(href).toBe(
            '/?provider=simulated&v=1&experience=recipe-console&view=monitor'
            + '&controlRunId=control%2Fa&distributedRunId=distributed%3Fa'
            + '&agentId=+agent%2F%E2%80%AE%5DreturnTo%3Dhttps%3A%2F%2F'
            + 'evil.example+'
            + '&recipeId=recipe%23a&commandId=command+a&transport=rtc',
        );
        const url = new URL(href!, 'https://app.example');
        expect(url.origin).toBe('https://app.example');
        for (const forbidden of [
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
            'controlUrl',
        ]) {
            expect(url.searchParams.has(forbidden), forbidden).toBe(false);
        }
    });

    it('returns no link without a supported source view and cannot be cast into a redirect', () => {
        expect(buildLegacyDiagnosticReturnHref({ version: 1 }))
            .toBeUndefined();
        expect(buildLegacyDiagnosticReturnHref({
            version: 1,
            view: 'https://evil.example' as 'monitor',
            provider: 'https://evil.example' as 'simulated',
            controlRunId: 'https://evil.example/steal',
        })).toBeUndefined();
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
        await act(async () => root.render(createElement(
            LegacyDiagnosticContextBar,
            { parsed },
        )));
        return parsed;
    }

    it('shows exact isolated context and a structural return anchor', async () => {
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
            view: 'monitor',
        }).toString());

        const owner = container.querySelector('[data-legacy-diagnostic-context]');
        expect(owner?.getAttribute('data-context-status')).toBe('ready');
        expect(owner?.textContent).toContain('Recipe Console diagnostic context');
        expect(owner?.textContent).toContain('Context only; not a client identity.');
        const values = [...owner?.querySelectorAll(
            '[data-legacy-diagnostic-context-value]',
        ) ?? []];
        expect(values.some(node => node.textContent === BIDI_AGENT)).toBe(true);
        expect(values.every(node => node.getAttribute('dir') === 'ltr')).toBe(true);
        const agentRow = owner?.querySelector('[data-context-field="agentId"]');
        expect(agentRow?.textContent).toContain('Agent');
        expect(agentRow?.textContent).not.toContain('Client');
        expect(agentRow?.textContent).not.toContain('Principal');

        const returnAnchor = owner?.querySelector<HTMLAnchorElement>(
            '[data-legacy-diagnostic-return]',
        );
        expect(returnAnchor?.textContent).toBe('Return to Monitor');
        expect(returnAnchor?.getAttribute('href')).toContain(
            '/?provider=browser-rallar&v=1&experience=recipe-console&view=monitor',
        );
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

    it('uses only a scoped CSS module and never mutates navigation', () => {
        const componentSource = readFileSync(
            `${SOURCE_ROOT}/LegacyDiagnosticContextBar.tsx`,
            'utf8',
        );
        const contextSource = readFileSync(
            `${SOURCE_ROOT}/legacy-diagnostic-context.ts`,
            'utf8',
        );
        const css = readFileSync(
            `${SOURCE_ROOT}/LegacyDiagnosticContextBar.module.css`,
            'utf8',
        );

        expect(componentSource).toContain(
            "from './LegacyDiagnosticContextBar.module.css'",
        );
        expect(componentSource).not.toMatch(/\bonClick\b|window\.|history\.|location\./);
        expect(contextSource).not.toMatch(/window\.|history\.|location\.|returnTo\s*:/);
        expect(contextSource).toContain(
            "from '../../../app/diagnostic-bridge-url-contract.ts'",
        );
        expect(contextSource).not.toContain('recipe-console/');
        expect(css).not.toMatch(/:global|(^|[}\n])\s*(html|body|a|button|section)\s*[{,]/m);
        expect(css).toMatch(/unicode-bidi:\s*isolate-override/);
    });
});

describe('legacy diagnostic context consumers', () => {
    const context = parseLegacyDiagnosticContext(
        '?diagnosticContext=1&view=monitor&controlRunId=control-context'
        + '&distributedRunId=distributed-context&commandId=command-context'
        + '&agentId=agent-display-only',
    ).context;

    it('makes command context the actual exact selection without falling back', () => {
        const history = [{
            commandId: 'command-other',
            kind: 'health',
            status: 'ok',
            ok: true,
            startedAtEpochMs: 1,
            endedAtEpochMs: 2,
            durationMs: 1,
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
        const state = {
            status: 'idle',
            commandHistory: [],
            events: [],
            failures: [],
            resultCache: {},
        } as const;

        function Harness({ commandId }: { commandId: string }) {
            const selection = useRunnerShellState(state, {
                version: 1,
                commandId,
            });
            useRunnerShellSelectionSync(selection);
            return createElement('button', {
                type: 'button',
                onClick: () => selection.setSelectedCommandId('manual-command'),
            }, selection.selectedCommandId);
        }

        await act(async () => root.render(createElement(Harness, {
            commandId: 'context-command-a',
        })));
        const button = container.querySelector('button');
        expect(button?.textContent).toBe('context-command-a');
        await act(async () => button?.click());
        expect(button?.textContent).toBe('manual-command');
        await act(async () => root.render(createElement(Harness, {
            commandId: 'context-command-a',
        })));
        expect(button?.textContent).toBe('manual-command');
        await act(async () => root.render(createElement(Harness, {
            commandId: 'context-command-b',
        })));
        expect(button?.textContent).toBe('context-command-b');

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
                'control-bootstrap',
            ],
        })).toEqual({ runId: 'control-context' });

        expect(resolveRunManagerRefreshSelection({
            preferredRunId: 'control-context',
            diagnosticControlRunId: 'control-context',
            controlRunId: 'control-live',
            bootstrapRunId: 'control-bootstrap',
            availableRunIds: ['control-live', 'control-bootstrap'],
        })).toEqual({
            runId: '',
            issue: 'Requested diagnostic control run is unavailable. No substitute was selected.',
        });

        expect(resolveRunManagerRefreshSelection({
            preferredRunId: '',
            diagnosticControlRunId: 'control-context',
            controlRunId: 'control-live',
            bootstrapRunId: 'control-bootstrap',
            availableRunIds: ['control-live', 'control-bootstrap'],
        })).toEqual({
            runId: '',
            issue: 'Requested diagnostic control run is unavailable. No substitute was selected.',
        });

        expect(resolveRunManagerRefreshSelection({
            preferredRunId: '',
            controlRunId: 'control-live',
            bootstrapRunId: 'control-bootstrap',
            availableRunIds: ['control-live', 'control-bootstrap'],
        })).toEqual({ runId: 'control-live' });
    });

    it('accepts only an exact available distributed pair and reports stale context', () => {
        const runs = [{
            controlRunId: 'control-context',
            distributedRunId: 'distributed-context',
        }, {
            controlRunId: 'control-other',
            distributedRunId: 'distributed-other',
        }];
        expect(deriveDistributedDiagnosticSelection({
            requestedControlRunId: 'control-context',
            requestedDistributedRunId: 'distributed-context',
            availableControlRunIds: ['control-context', 'control-other'],
            distributedRuns: runs,
        })).toEqual({
            controlRunId: 'control-context',
            distributedRunId: 'distributed-context',
        });
        expect(deriveDistributedDiagnosticSelection({
            requestedControlRunId: 'control-missing',
            requestedDistributedRunId: 'distributed-context',
            availableControlRunIds: ['control-context'],
            distributedRuns: runs,
        })).toEqual({
            controlRunId: '',
            issue: 'Requested diagnostic control run is unavailable. No substitute was selected.',
        });
        expect(deriveDistributedDiagnosticSelection({
            requestedControlRunId: 'control-context',
            requestedDistributedRunId: 'distributed-other',
            availableControlRunIds: ['control-context', 'control-other'],
            distributedRuns: runs,
        })).toEqual({
            controlRunId: 'control-context',
            issue: 'Requested diagnostic distributed run does not belong to the requested control run.',
        });
    });

    it('parses once at the experience root and keeps absent old links uncluttered', () => {
        const experience = readFileSync(
            'apps/rallar-black-box/src/legacy/shell/LegacyExperience.tsx',
            'utf8',
        );
        const shell = readFileSync(
            'apps/rallar-black-box/src/legacy/shell/LegacyAppShell.tsx',
            'utf8',
        );
        const globalHook = readFileSync(
            'apps/rallar-black-box/src/legacy/shell/use-command-center-global-context.ts',
            'utf8',
        );
        const runManager = readFileSync(
            'apps/rallar-black-box/src/legacy/runner/run-manager/RunManagerPanel.tsx',
            'utf8',
        );
        const distributed = readFileSync(
            'apps/rallar-black-box/src/legacy/runner/distributed-recipes/DistributedRecipesPanel.tsx',
            'utf8',
        );

        expect(experience.match(/parseLegacyDiagnosticContext\(/g)).toHaveLength(1);
        expect(experience).toContain('LegacyDiagnosticContextProvider');
        expect(experience).toContain('diagnosticContext={diagnosticContext}');
        expect(shell).toMatch(
            /diagnosticContext\.status !== 'absent'[\s\S]*<LegacyDiagnosticContextBar/,
        );
        expect(globalHook).toContain('diagnosticContextChanged');
        expect(runManager).toContain('useLegacyDiagnosticContext');
        expect(runManager).toContain('refreshGeneration');
        expect(distributed).toContain('useLegacyDiagnosticContext');
        for (const source of [experience, shell, globalHook, runManager, distributed]) {
            expect(source).not.toMatch(/localStorage|sessionStorage/);
        }
    });
});
