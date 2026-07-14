import { describe, expect, it } from 'vitest';
import { resolveAppExperience } from '../../../apps/rallar-black-box/src/app/experience-route.ts';
import {
    createLegacyMonitorHref,
} from '../../../apps/rallar-black-box/src/recipe-console/monitor/legacy-monitor-link.ts';
import type {
    RecipeConsoleUrlState,
} from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';

const MONITOR_STATE: RecipeConsoleUrlState = {
    v: 1,
    experience: 'recipe-console',
    view: 'monitor',
    controlRunId: ' control-run-a ',
    distributedRunId: 'distributed-run-a',
    agentId: 'agent/a',
    recipeId: 'recipe-a',
    commandId: 'command-a',
};

describe('Recipe Console legacy Monitor link', () => {
    it('opens the registered legacy Runs route with the selected Monitor context', () => {
        const href = createLegacyMonitorHref(
            MONITOR_STATE,
            '?provider=browser-rallar',
        );
        const url = new URL(href, 'https://console.test/operator');

        expect(url.pathname).toBe('/');
        expect(resolveAppExperience(url.search)).toBe('legacy');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            experience: 'legacy',
            workspace: 'black-box-runner',
            tab: 'runs',
            provider: 'browser-rallar',
            controlRunId: 'control-run-a',
            distributedRunId: 'distributed-run-a',
            agentId: 'agent/a',
            recipeId: 'recipe-a',
            commandId: 'command-a',
        });
    });

    it('drops credentials, endpoints, headers, and unknown current query state', () => {
        const sourceSearch = new URLSearchParams({
            provider: 'simulated',
            baseUrl: 'https://api.test/private',
            apiBaseUrl: 'https://api.test/private',
            controlUrl: 'wss://control.test/control?token=nested-secret',
            token: 'query-secret',
            Authorization: 'Bearer authorization-secret',
            headers: '{"X-Secret":"header-secret"}',
            secret: 'unknown-secret',
            futureField: 'unknown-value',
        }).toString();
        const stateWithUnknownSecrets = {
            ...MONITOR_STATE,
            accessToken: 'state-secret',
            controlUrl: 'wss://state.test/control?token=state-nested-secret',
        } as RecipeConsoleUrlState;

        const href = createLegacyMonitorHref(
            stateWithUnknownSecrets,
            `?${sourceSearch}`,
        );
        const url = new URL(href, 'https://console.test/operator');

        expect([...url.searchParams.keys()]).toEqual([
            'experience',
            'workspace',
            'tab',
            'provider',
            'controlRunId',
            'distributedRunId',
            'agentId',
            'recipeId',
            'commandId',
        ]);
        expect(href).not.toMatch(
            /api\.test|control\.test|query-secret|authorization-secret|header-secret|unknown-secret|unknown-value|state-secret|state-nested-secret/,
        );
    });

    it('omits unsupported providers and blank evidence identities', () => {
        const href = createLegacyMonitorHref({
            v: 1,
            experience: 'recipe-console',
            view: 'monitor',
            controlRunId: '   ',
        }, '?provider=https%3A%2F%2Fevil.test%2F%3Ftoken%3Dsecret');
        const url = new URL(href, 'https://console.test/operator');

        expect(url.searchParams.has('provider')).toBe(false);
        expect(url.searchParams.has('controlRunId')).toBe(false);
        expect(href).not.toContain('evil.test');
        expect(href).not.toContain('secret');
    });
});
