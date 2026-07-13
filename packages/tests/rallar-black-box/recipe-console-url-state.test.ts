import { describe, expect, it } from 'vitest';
import { resolveAppExperience } from '../../../apps/rallar-black-box/src/app/experience-route.ts';
import { scrubRecipeConsoleHrefBeforeLoad } from '../../../apps/rallar-black-box/src/app/recipe-console-url-guard.ts';
import { createRunnerAgentLaunchUrl } from '../../../apps/rallar-black-box/src/runner-agent-launch.ts';
import {
    RECIPE_CONSOLE_URL_STRING_MAX_BYTES,
    RECIPE_CONSOLE_SENSITIVE_URL_KEYS,
    type RecipeConsoleUrlState,
} from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';
import {
    createRecipeConsoleShareHref,
    parseRecipeConsoleUrl,
    serializeRecipeConsoleUrl,
} from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-codec.ts';
import {
    recipeConsoleExecuteRecipeSelectionPatch,
} from '../../../apps/rallar-black-box/src/recipe-console/execute/execute-workflow-state.ts';

const BASE_STATE: RecipeConsoleUrlState = {
    v: 1,
    experience: 'recipe-console',
    view: 'execute',
};

function lowerCaseKeys(search: string): string[] {
    return [...new URLSearchParams(search).keys()].map(key => key.toLowerCase());
}

describe('Recipe Console URL state codec', () => {
    it('drops over-budget string filters before they can become stale worker authority', () => {
        const overBudget = '界'.repeat(
            Math.floor(RECIPE_CONSOLE_URL_STRING_MAX_BYTES / 3) + 1,
        );
        const parsed = parseRecipeConsoleUrl(
            `?v=1&experience=recipe-console&view=analyze&historyQuery=${encodeURIComponent(overBudget)}`,
        );

        expect(parsed.state.historyQuery).toBeUndefined();
        expect(parsed.issues).toContainEqual(expect.objectContaining({
            field: 'historyQuery',
            code: 'invalid',
        }));
        expect(new URLSearchParams(parsed.canonicalSearch).has('historyQuery'))
            .toBe(false);
        expect(new URLSearchParams(serializeRecipeConsoleUrl({
            ...BASE_STATE,
            view: 'analyze',
            historyQuery: overBudget,
        })).has('historyQuery')).toBe(false);
    });

    it('round-trips an unknown explicit recipe identity without choosing a fallback', () => {
        const parsed = parseRecipeConsoleUrl(
            '?v=1&experience=recipe-console&view=execute&recipeId=unknown-explicit',
        );

        expect(parsed.state.recipeId).toBe('unknown-explicit');
        expect(new URLSearchParams(parsed.canonicalSearch).get('recipeId'))
            .toBe('unknown-explicit');
    });

    it('serializes a recipe selection after clearing dependent run identity', () => {
        const serialized = serializeRecipeConsoleUrl({
            ...BASE_STATE,
            controlRunId: 'run-a',
            distributedRunId: 'distributed-a',
            commandId: 'command-a',
            ...recipeConsoleExecuteRecipeSelectionPatch('recipe-next'),
        });
        const params = new URLSearchParams(serialized);

        expect(params.get('recipeId')).toBe('recipe-next');
        expect(params.get('controlRunId')).toBe('run-a');
        expect(params.has('distributedRunId')).toBe(false);
        expect(params.has('commandId')).toBe(false);
    });

    it('parses and serializes the complete approved field set', () => {
        const params = new URLSearchParams({
            v: '1',
            experience: 'recipe-console',
            view: 'advanced',
            controlRunId: ' control-a ',
            distributedRunId: ' distributed-a ',
            agentId: ' agent-a ',
            recipeId: ' recipe-a ',
            commandId: ' command-a ',
            diagnosticSeverity: 'warning',
            transport: 'messages.rtc',
            historyQuery: ' failed ack ',
            historyGroup: ' bb-group ',
            historyRecipeId: ' health-only ',
            historyProfile: ' smoke ',
            failureCategory: 'readiness',
            status: 'waiting-for-barrier',
            from: '100',
            to: '900',
            compareLeft: ' baseline-a ',
            compareRight: ' candidate-a ',
            timingMetric: 'stream-cadence',
            fleetRegion: ' eu-north ',
            fleetMapLayers: 'observed-routes,failures,live-agents',
            legacySurface: ' rtc-diagnostics ',
        });

        const parsed = parseRecipeConsoleUrl(`?${params.toString()}`);

        expect(parsed.state).toEqual({
            v: 1,
            experience: 'recipe-console',
            view: 'advanced',
            controlRunId: 'control-a',
            distributedRunId: 'distributed-a',
            agentId: 'agent-a',
            recipeId: 'recipe-a',
            commandId: 'command-a',
            diagnosticSeverity: 'warning',
            transport: 'messages.rtc',
            historyQuery: 'failed ack',
            historyGroup: 'bb-group',
            historyRecipeId: 'health-only',
            historyProfile: 'smoke',
            failureCategory: 'readiness',
            status: 'waiting-for-barrier',
            from: 100,
            to: 900,
            compareLeft: 'baseline-a',
            compareRight: 'candidate-a',
            timingMetric: 'stream-cadence',
            fleetRegion: 'eu-north',
            fleetMapLayers: ['live-agents', 'failures', 'observed-routes'],
            legacySurface: 'rtc-diagnostics',
        });
        expect(parseRecipeConsoleUrl(parsed.canonicalSearch).state).toEqual(parsed.state);
        expect(parsed.issues.map(issue => issue.code)).toContain('normalized');
        expect(parsed.needsReplace).toBe(true);
    });

    it('defaults a missing view visibly while retaining valid and unknown fields', () => {
        const parsed = parseRecipeConsoleUrl(
            '?provider=simulated&roomId=room-a&futureField=future' +
            '&experience=recipe-console&controlRunId=run-a',
        );

        expect(parsed.state).toMatchObject({
            v: 1,
            experience: 'recipe-console',
            view: 'execute',
            controlRunId: 'run-a',
        });
        expect(parsed.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'v', code: 'missing' }),
            expect.objectContaining({ field: 'view', code: 'missing' }),
        ]));
        expect(parsed.canonicalSearch).toContain('provider=simulated');
        expect(parsed.canonicalSearch).toContain('roomId=room-a');
        expect(parsed.canonicalSearch).toContain('futureField=future');
        expect(parsed.needsReplace).toBe(true);
    });

    it('uses the first duplicate value and reports duplicate and range normalization', () => {
        const parsed = parseRecipeConsoleUrl(
            '?provider=simulated&v=1&experience=recipe-console&view=monitor&view=tune' +
            '&historyGroup=group-a&historyGroup=group-b' +
            '&failureCategory=readiness&failureCategory=barrier' +
            '&from=900&to=100&fleetMapLayers=failures,live-agents',
        );

        expect(parsed.state).toMatchObject({
            view: 'monitor',
            historyGroup: 'group-a',
            failureCategory: 'readiness',
            from: 100,
            to: 900,
            fleetMapLayers: ['live-agents', 'failures'],
        });
        expect(parsed.issues.map(issue => issue.code)).toEqual(
            expect.arrayContaining(['duplicate', 'normalized']),
        );
        expect(parsed.issues).toContainEqual(expect.objectContaining({
            field: 'view',
            code: 'duplicate',
            value: 'tune',
        }));
        expect(parsed.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({
                field: 'historyGroup',
                code: 'duplicate',
                value: 'group-b',
            }),
            expect.objectContaining({
                field: 'failureCategory',
                code: 'duplicate',
                value: 'barrier',
            }),
        ]));
        expect(parsed.canonicalSearch).toContain('provider=simulated');
    });

    it('treats all enums as case-sensitive and keeps their failures visible', () => {
        const parsed = parseRecipeConsoleUrl(
            '?v=1&experience=recipe-console&view=Monitor' +
            '&diagnosticSeverity=ERROR&transport=HTTP&status=Running' +
            '&failureCategory=Readiness' +
            '&timingMetric=Command-Duration&fleetMapLayers=Failures',
        );

        expect(parsed.state).toEqual({
            v: 1,
            experience: 'recipe-console',
            view: 'execute',
            fleetMapLayers: [],
        });
        expect(parsed.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'view', code: 'invalid' }),
            expect.objectContaining({ field: 'diagnosticSeverity', code: 'invalid' }),
            expect.objectContaining({ field: 'transport', code: 'invalid' }),
            expect.objectContaining({ field: 'status', code: 'invalid' }),
            expect.objectContaining({ field: 'failureCategory', code: 'invalid' }),
            expect.objectContaining({ field: 'timingMetric', code: 'invalid' }),
            expect.objectContaining({ field: 'fleetMapLayers', code: 'invalid' }),
        ]));
        expect(new URLSearchParams(parsed.canonicalSearch).has('failureCategory'))
            .toBe(false);
    });

    it('copies committed History filters without conflating the operational recipe identity', () => {
        const href = createRecipeConsoleShareHref({
            origin: 'https://console.test',
            pathname: '/operator',
            search: '?provider=simulated&futureField=keep&TOKEN=query-secret',
            hash: '#trace=keep',
        }, {
            ...BASE_STATE,
            view: 'tune',
            recipeId: 'operational-recipe',
            historyQuery: 'failed ack',
            historyGroup: 'bb-group',
            historyRecipeId: 'history-recipe',
            historyProfile: 'smoke',
            failureCategory: 'readiness',
            status: 'failed',
            from: 100,
            to: 900,
            compareLeft: 'baseline-a',
            compareRight: 'candidate-a',
            timingMetric: 'stream-cadence',
        });
        const copied = new URL(href);

        expect(Object.fromEntries(copied.searchParams)).toMatchObject({
            provider: 'simulated',
            futureField: 'keep',
            recipeId: 'operational-recipe',
            historyQuery: 'failed ack',
            historyGroup: 'bb-group',
            historyRecipeId: 'history-recipe',
            historyProfile: 'smoke',
            failureCategory: 'readiness',
            status: 'failed',
            from: '100',
            to: '900',
            compareLeft: 'baseline-a',
            compareRight: 'candidate-a',
            timingMetric: 'stream-cadence',
        });
        expect(copied.searchParams.has('TOKEN')).toBe(false);
        expect(copied.hash).toBe('#trace=keep');
        expect(parseRecipeConsoleUrl(copied.search).state).toMatchObject({
            recipeId: 'operational-recipe',
            historyRecipeId: 'history-recipe',
            failureCategory: 'readiness',
        });
    });

    it('round-trips raw RTC artifact transport evidence for Analyze filters', () => {
        const parsed = parseRecipeConsoleUrl(
            '?v=1&experience=recipe-console&view=analyze&transport=rtc',
        );

        expect(parsed.state.transport).toBe('rtc');
        expect(new URLSearchParams(parsed.canonicalSearch).get('transport'))
            .toBe('rtc');
        expect(parsed.issues.some(issue => issue.field === 'transport')).toBe(false);
    });

    it('accepts only safe nonnegative integer epoch milliseconds', () => {
        const valid = parseRecipeConsoleUrl(
            '?v=1&experience=recipe-console&view=analyze&from=0&to=9007199254740991',
        );
        expect(valid.state).toMatchObject({ from: 0, to: Number.MAX_SAFE_INTEGER });

        const invalid = parseRecipeConsoleUrl(
            '?v=1&experience=recipe-console&view=analyze&from=-1&to=9007199254740992',
        );
        expect(invalid.state.from).toBeUndefined();
        expect(invalid.state.to).toBeUndefined();
        expect(invalid.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'from', code: 'invalid' }),
            expect.objectContaining({ field: 'to', code: 'invalid' }),
        ]));
    });

    it('represents an explicit empty fleet-layer selection as none', () => {
        const parsed = parseRecipeConsoleUrl(
            '?v=1&experience=recipe-console&view=fleet&fleetMapLayers=none',
        );

        expect(parsed.state.fleetMapLayers).toEqual([]);
        expect(new URLSearchParams(parsed.canonicalSearch).get('fleetMapLayers')).toBe('none');
        expect(parsed.issues.some(issue => issue.field === 'fleetMapLayers')).toBe(false);
    });

    it('keeps legacySurface only while Advanced is selected', () => {
        const inapplicable = parseRecipeConsoleUrl(
            '?v=1&experience=recipe-console&view=monitor&legacySurface=rtc-diagnostics',
        );
        expect(inapplicable.state.legacySurface).toBeUndefined();
        expect(inapplicable.issues).toContainEqual(expect.objectContaining({
            field: 'legacySurface',
            code: 'inapplicable',
        }));
        expect(new URLSearchParams(inapplicable.canonicalSearch).has('legacySurface')).toBe(false);

        const advanced = parseRecipeConsoleUrl(
            '?v=1&experience=recipe-console&view=advanced&legacySurface=%20rtc-diagnostics%20',
        );
        expect(advanced.state.legacySurface).toBe('rtc-diagnostics');
    });

    it('preserves unknown parameters and removes old aliases only from Recipe Console output', () => {
        const baseSearch =
            '?provider=simulated&roomId=room-a&future=value&workspace=black-box-runner' +
            '&appMode=runner&tab=fleet&advancedSurface=workbench&advanced=manual&mode=control';
        const serialized = serializeRecipeConsoleUrl({
            ...BASE_STATE,
            view: 'fleet',
        }, baseSearch);
        const params = new URLSearchParams(serialized);

        expect(params.get('provider')).toBe('simulated');
        expect(params.get('roomId')).toBe('room-a');
        expect(params.get('future')).toBe('value');
        expect(params.get('v')).toBe('1');
        expect(params.get('experience')).toBe('recipe-console');
        expect(params.get('view')).toBe('fleet');
        for (const key of [
            'workspace',
            'appMode',
            'tab',
            'advancedSurface',
            'advanced',
            'mode',
        ]) {
            expect(params.has(key), key).toBe(false);
        }
        expect(baseSearch).toContain('workspace=black-box-runner');
    });

    it('removes every sensitive key case-insensitively during parse and serialization', () => {
        const base = new URLSearchParams({
            provider: 'simulated',
            v: '1',
            experience: 'recipe-console',
            view: 'monitor',
        });
        for (const key of RECIPE_CONSOLE_SENSITIVE_URL_KEYS) {
            base.append(key, `secret-${key}`);
            base.append(key.toUpperCase(), `upper-secret-${key}`);
        }

        const parsed = parseRecipeConsoleUrl(`?${base.toString()}`);
        const serialized = serializeRecipeConsoleUrl(BASE_STATE, `?${base.toString()}`);
        const sensitive = new Set(RECIPE_CONSOLE_SENSITIVE_URL_KEYS.map(key => key.toLowerCase()));

        expect(lowerCaseKeys(parsed.canonicalSearch).filter(key => sensitive.has(key))).toEqual([]);
        expect(lowerCaseKeys(serialized).filter(key => sensitive.has(key))).toEqual([]);
        expect(parsed.canonicalSearch).toContain('provider=simulated');
        expect(JSON.stringify(parsed.issues)).not.toContain('secret-');
    });

    it('scrubs query and fragment secrets from copied links without losing safe fields', () => {
        const href = createRecipeConsoleShareHref({
            origin: 'https://console.test',
            pathname: '/operator',
            search: '?provider=simulated&TOKEN=query-secret&roomId=room-a',
            hash: '#agentSessionTicket=fragment-secret&trace=keep&PaSsWoRd=also-secret&pane=evidence',
        }, {
            ...BASE_STATE,
            view: 'monitor',
            controlRunId: 'run-a',
        });
        const url = new URL(href);

        expect(url.origin).toBe('https://console.test');
        expect(url.pathname).toBe('/operator');
        expect(url.searchParams.get('provider')).toBe('simulated');
        expect(url.searchParams.get('roomId')).toBe('room-a');
        expect(lowerCaseKeys(url.search).some(key => key === 'token')).toBe(false);
        expect(url.hash).toBe('#trace=keep&pane=evidence');
        expect(href).not.toContain('query-secret');
        expect(href).not.toContain('fragment-secret');
        expect(href).not.toContain('also-secret');
    });

    it('removes control server URLs and their nested tokens from explicit canonical and copied links', () => {
        const controlUrl = 'wss://control.test/control?token=nested-control-secret';
        const baseSearch = new URLSearchParams({
            provider: 'simulated',
            v: '1',
            experience: 'recipe-console',
            view: 'monitor',
            controlUrl,
            CONTROLURL: 'wss://other.test/control?token=upper-nested-secret',
        }).toString();

        const parsed = parseRecipeConsoleUrl(`?${baseSearch}`);
        const serialized = serializeRecipeConsoleUrl(BASE_STATE, `?${baseSearch}`);
        const href = createRecipeConsoleShareHref({
            origin: 'https://console.test',
            pathname: '/operator',
            search: `?${baseSearch}`,
            hash: '#trace=keep',
        }, BASE_STATE);

        for (const output of [parsed.canonicalSearch, serialized, href]) {
            const url = new URL(output, 'https://console.test/operator');
            expect(lowerCaseKeys(url.search)).not.toContain('controlurl');
            expect(output).not.toContain('nested-control-secret');
            expect(output).not.toContain('upper-nested-secret');
        }
        expect(parsed.canonicalSearch).toContain('provider=simulated');
        expect(href).toContain('provider=simulated');
    });

    it('scrubs Recipe Console secrets synchronously without canonicalizing diagnostic fields', () => {
        const input = 'https://console.test/operator' +
            '?provider=simulated&v=1&experience=recipe-console&view=unsupported' +
            '&futureField=keep&TOKEN=query-secret' +
            '&CONTROLURL=wss%3A%2F%2Fcontrol.test%2Fcontrol%3Ftoken%3Dnested-secret' +
            '#agentSessionTicket=fragment-secret&trace=keep&PaSsWoRd=fragment-password';

        const output = new URL(scrubRecipeConsoleHrefBeforeLoad(input));

        expect(output.searchParams.get('provider')).toBe('simulated');
        expect(output.searchParams.get('view')).toBe('unsupported');
        expect(output.searchParams.get('futureField')).toBe('keep');
        expect(lowerCaseKeys(output.search)).not.toContain('token');
        expect(lowerCaseKeys(output.search)).not.toContain('controlurl');
        expect(output.hash).toBe('#trace=keep');
        expect(output.href).not.toContain('query-secret');
        expect(output.href).not.toContain('nested-secret');
        expect(output.href).not.toContain('fragment-secret');
        expect(output.href).not.toContain('fragment-password');
    });

    it('keeps controlUrl on legacy runner-agent links and resolves them as legacy', () => {
        const controlUrl = 'wss://control.test/control?token=legacy-agent-token';
        const href = createRunnerAgentLaunchUrl({
            origin: 'https://console.test',
            providerMode: 'simulated',
            controlWsUrl: controlUrl,
            runId: 'run-a',
            agentId: 'agent-a',
            groupId: 'group-a',
            apiBaseUrl: 'https://api.test',
            applicationId: 'rallar-black-box',
            workspaceId: 'default',
        });
        const url = new URL(href);

        expect(url.searchParams.get('controlUrl')).toBe(controlUrl);
        expect(resolveAppExperience(url.search)).toBe('legacy');
    });

    it('leaves credential-bearing runner-agent links byte-for-byte unchanged', () => {
        const href = createRunnerAgentLaunchUrl({
            origin: 'https://console.test',
            providerMode: 'browser-rallar',
            controlWsUrl: 'wss://control.test/control?token=nested-agent-token',
            runId: 'run-a',
            agentId: 'agent-a',
            groupId: 'group-a',
            apiBaseUrl: 'https://api.test',
            applicationId: 'rallar-black-box',
            workspaceId: 'default',
            controlToken: 'runner-control-token',
            agentSessionTicket: 'one-time-agent-ticket',
        });

        expect(scrubRecipeConsoleHrefBeforeLoad(href)).toBe(href);
    });

    it('preserves a non-field fragment exactly in a copied link', () => {
        const href = createRecipeConsoleShareHref({
            origin: 'https://console.test',
            pathname: '/operator',
            search: '',
            hash: '#trace',
        }, BASE_STATE);

        expect(new URL(href).hash).toBe('#trace');
    });

    it('removes a bare sensitive fragment from a copied link', () => {
        const href = createRecipeConsoleShareHref({
            origin: 'https://console.test',
            pathname: '/operator',
            search: '',
            hash: '#TOKEN',
        }, BASE_STATE);

        expect(new URL(href).hash).toBe('');
    });
});
