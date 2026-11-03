import { describe, expect, it } from 'vitest';
import {
    parseApiV1BlackBoxArgs,
    toApiV1BlackBoxEnvironment,
    toManagedApiServerPlans
} from '../../shared-test/black-box-runner/api-v1-black-box-run.mts';

describe('API recipe endpoint selection', () => {
    it.each(['pglite-memory', 'pglite-file', 'postgres'])(
        'uses the actual managed single-server port for all %s recipe targets',
        (backend) => {
            const options = parseApiV1BlackBoxArgs([`--backend=${backend}`, '--port=18081']);
            const env = toApiV1BlackBoxEnvironment(options, {
                RALLAR_API_BASE_URL_SECONDARY: 'https://unmanaged.example.test',
                RALLAR_WS_BASE_URL_TERTIARY: 'wss://unmanaged.example.test'
            });
            for (const suffix of ['', '_SECONDARY', '_TERTIARY']) {
                expect(env[`RALLAR_API_BASE_URL${suffix}`]).toBe('http://127.0.0.1:18081');
                expect(env[`RALLAR_WS_BASE_URL${suffix}`]).toBe('ws://127.0.0.1:18081');
            }
        }
    );

    it('keeps explicitly supplied external targets in recipes-only mode', () => {
        const options = parseApiV1BlackBoxArgs(['--recipes-only']);
        const targets = {
            RALLAR_API_BASE_URL: 'https://primary.example.test',
            RALLAR_WS_BASE_URL: 'wss://primary.example.test',
            RALLAR_API_BASE_URL_SECONDARY: 'https://secondary.example.test',
            RALLAR_WS_BASE_URL_SECONDARY: 'wss://secondary.example.test',
            RALLAR_API_BASE_URL_TERTIARY: 'https://tertiary.example.test',
            RALLAR_WS_BASE_URL_TERTIARY: 'wss://tertiary.example.test'
        };
        expect(toApiV1BlackBoxEnvironment(options, targets)).toMatchObject(targets);
    });

    it('defaults missing external targets to the selected primary endpoint', () => {
        const options = parseApiV1BlackBoxArgs(['--recipes-only']);
        const env = toApiV1BlackBoxEnvironment(options, {
            RALLAR_API_BASE_URL: 'https://primary.example.test',
            RALLAR_WS_BASE_URL: 'wss://primary.example.test'
        });
        expect(env.RALLAR_API_BASE_URL_SECONDARY).toBe('https://primary.example.test');
        expect(env.RALLAR_API_BASE_URL_TERTIARY).toBe('https://primary.example.test');
        expect(env.RALLAR_WS_BASE_URL_SECONDARY).toBe('wss://primary.example.test');
        expect(env.RALLAR_WS_BASE_URL_TERTIARY).toBe('wss://primary.example.test');
    });

    it('points every managed cluster target at its separately started server', () => {
        const options = parseApiV1BlackBoxArgs([
            '--port=19080', '--secondary-port=19081', '--tertiary-port=19082'
        ]);
        const env = toApiV1BlackBoxEnvironment(options, {});
        const plans = toManagedApiServerPlans(options, env, '/tmp/api-endpoint-plans');
        expect(plans.map((plan) => plan.baseUrl)).toEqual([
            env.RALLAR_API_BASE_URL, env.RALLAR_API_BASE_URL_SECONDARY, env.RALLAR_API_BASE_URL_TERTIARY
        ]);
        expect(plans.map((plan) => plan.port)).toEqual([19080, 19081, 19082]);
    });
});
