import { expect, it } from 'vitest';

import { parseApiV1BlackBoxArgs, toApiV1BlackBoxEnvironment, toManagedApiServerPlans } from '@shared-test/black-box-runner/api-v1-black-box-run.mts';

it.each([
    { environment: {}, origin: 'https://browser.example.test', allowlist: 'https://browser.example.test' },
    {
        environment: {
            RALLAR_DIRECTORY_BROWSER_ORIGIN: 'https://client.example.test',
            CORS_ORIGINS: 'https://client.example.test,https://operator.example.test'
        },
        origin: 'https://client.example.test',
        allowlist: 'https://client.example.test,https://operator.example.test'
    }
])('hands the recipe origin and explicit server allowlist to every managed process: $origin', ({ environment, origin, allowlist }) => {
    const options = parseApiV1BlackBoxArgs(['--backend=postgres', '--secondary-port=18081', '--tertiary-port=18082']);
    const resolved = toApiV1BlackBoxEnvironment(options, environment);
    expect(resolved.RALLAR_DIRECTORY_BROWSER_ORIGIN).toBe(origin);
    const plans = toManagedApiServerPlans(options, resolved, '/tmp/browser-origin-evidence');
    expect(plans.map((plan) => plan.env.CORS_ORIGINS)).toEqual([allowlist, allowlist, allowlist]);
});
