import { describe, expect, it } from 'vitest';
import { validateDenoDeployApiEnvironment } from '../../../scripts/deploy/verify-deno-deploy-api-configuration.mjs';

interface DenoDeployEnvironmentFixture {
    readonly name: string;
    readonly value: string | null;
    readonly secret?: boolean;
    readonly contexts: readonly string[] | null;
}

const sharedProductionEnvironment = [
    plain('RALLAR_API_CONFIGURATION_PROFILE', 'prod'),
    plain('AUTH_ADMIN_CLIENT_IDS', 'operations-admin'),
    plain('RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS', 'operations-admin'),
    plain('METERED_APP_NAME', 'rallar-production'),
    secret('DATABASE_URL'),
    secret('RALLAR_AUTH_CREDENTIAL_SECRET'),
    secret('METERED_API_KEY'),
    secret('RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET')
];

describe('Deno Deploy API configuration evidence', () => {
    it('accepts a complete API-v1 prod environment without reading secret values', () => {
        expect(validateDenoDeployApiEnvironment(
            sharedProductionEnvironment,
            'api-v1'
        )).toEqual([]);
    });

    it('treats the Deno Deploy all-context JSON shape as production evidence', () => {
        const allContextEnvironment = sharedProductionEnvironment.map((entry) => ({
            key: entry.name,
            value: entry.value,
            isSecret: entry.secret === true,
            contexts: null
        }));

        expect(validateDenoDeployApiEnvironment(
            allContextEnvironment,
            'api-v1'
        )).toEqual([]);
    });

    it('accepts production evidence when Deno omits its managed DATABASE_URL', () => {
        const environmentWithoutDatabaseUrl = sharedProductionEnvironment.filter(
            (entry) => entry.name !== 'DATABASE_URL'
        );

        expect(validateDenoDeployApiEnvironment(
            environmentWithoutDatabaseUrl,
            'api-v1'
        )).toEqual([]);
    });

    it('requires the Relic policy in addition to the embedded API-v1 prod environment', () => {
        expect(validateDenoDeployApiEnvironment(
            sharedProductionEnvironment,
            'relic'
        )).toEqual(['RELIC_REST_AUTH_MODE is missing from the production context.']);
        expect(validateDenoDeployApiEnvironment(
            [...sharedProductionEnvironment, plain('RELIC_REST_AUTH_MODE', 'group-policy')],
            'relic'
        )).toEqual([]);
    });

    it('rejects an absent or non-prod selector and missing production secrets', () => {
        const missingSelector = sharedProductionEnvironment.filter(
            (entry) => entry.name !== 'RALLAR_API_CONFIGURATION_PROFILE'
        );
        expect(validateDenoDeployApiEnvironment(missingSelector, 'api-v1')).toContain(
            'RALLAR_API_CONFIGURATION_PROFILE is missing from the production context.'
        );

        const wrongSelector = sharedProductionEnvironment.map((entry) =>
            entry.name === 'RALLAR_API_CONFIGURATION_PROFILE'
                ? plain(entry.name, 'prod-in-memory')
                : entry
        );
        expect(validateDenoDeployApiEnvironment(wrongSelector, 'api-v1')).toContain(
            'RALLAR_API_CONFIGURATION_PROFILE must equal prod in the production context.'
        );

        const missingSecret = sharedProductionEnvironment.filter(
            (entry) => entry.name !== 'METERED_API_KEY'
        );
        expect(validateDenoDeployApiEnvironment(missingSecret, 'api-v1')).toContain(
            'METERED_API_KEY is missing from the production context.'
        );
    });

    it('does not include environment values in validation failures', () => {
        const secretValue = 'credential-value-that-must-never-appear';
        const invalid = [
            ...sharedProductionEnvironment,
            {
                name: 'RELIC_REST_AUTH_MODE',
                value: secretValue,
                contexts: ['production']
            }
        ];
        const errors = validateDenoDeployApiEnvironment(invalid, 'relic');

        expect(errors).toContain(
            'RELIC_REST_AUTH_MODE must equal group-policy in the production context.'
        );
        expect(JSON.stringify(errors)).not.toContain(secretValue);
    });
});

function plain(name: string, value: string): DenoDeployEnvironmentFixture {
    return { name, value, contexts: ['production'] };
}

function secret(name: string): DenoDeployEnvironmentFixture {
    return { name, value: null, secret: true, contexts: ['production'] };
}
