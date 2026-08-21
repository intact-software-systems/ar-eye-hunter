import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    authCompatibilityConsumerInventory,
    readAuthCompatibilityConsumers,
    readAuthCompatibilityGovernanceIdentityConsumers,
    readAuthCompatibilityIdentityConsumers
} from './auth-server-compatibility-consumer-inventory.ts';
import { readAuthCompatibilityExportViolations, readModuleReferences } from './auth-server-compatibility-governance-validation.ts';

const validationPath = 'packages/tests/repo/auth-server-compatibility-governance-validation.ts';
const canonicalAuthTestRoot = 'packages/tests/shared-server/auth';
const runtimeIdentityGovernanceTest = 'packages/tests/repo/auth-server-compatibility-runtime-identity.test.ts';

it('requires fail-closed compatibility exports and consumer discovery', () => {
    expect(existsSync(path.join(process.cwd(), validationPath)), validationPath).toBe(true);
});

it('locks every runtime and type export to its direct canonical owner', () => {
    expect(readAuthCompatibilityExportViolations(readRepositorySource)).toEqual([]);
});

describe('compatibility export mutation fixtures', () => {
    it('rejects export kind, target, and second-hop changes', () => {
        const wrapper = 'packages/shared-server/rallar-system/services/AppAuthInboxService.ts';
        const canonical = 'packages/shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
        const mutations = [
            new Map([
                [
                    wrapper,
                    readRepositorySource(wrapper).replace(
                        'export { AppAuthInboxService }',
                        'export type { AppAuthInboxService }'
                    )
                ]
            ]),
            new Map([
                [
                    wrapper,
                    readRepositorySource(wrapper).replace(
                        '\'../auth/inbox/app-auth-inbox-service.ts\'',
                        '\'../auth/inbox/auth-app-inbox-routing.ts\''
                    )
                ]
            ]),
            new Map([[canonical, 'export { AppAuthInboxService } from \'./second-hop.ts\';']])
        ];

        for (const overrides of mutations) {
            expect(readAuthCompatibilityExportViolations(withOverrides(overrides))).not.toEqual([]);
        }
    });
});

describe('compatibility consumer scanner fixtures', () => {
    it.each(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'])(
        'discovers static, dynamic, and require references in .%s',
        (extension) => {
            const source = [
                'import value from \'./static.ts\';',
                'const dynamic = import(\'./dynamic.ts\');',
                'const required = require(\'./required.ts\');'
            ].join('\n');

            expect(readModuleReferences(`fixture.${extension}`, source)).toEqual([
                { kind: 'static', requiresRuntimeIdentity: true, specifier: './static.ts' },
                { kind: 'dynamic', requiresRuntimeIdentity: true, specifier: './dynamic.ts' },
                { kind: 'require', requiresRuntimeIdentity: true, specifier: './required.ts' }
            ]);
        }
    );

    it('discovers type-only and import-equals references explicitly', () => {
        const source = [
            'import type { Value } from \'./type-only.ts\';',
            'import RequiredValue = require(\'./import-equals.ts\');'
        ].join('\n');

        expect(readModuleReferences('fixture.ts', source)).toEqual([
            { kind: 'static', requiresRuntimeIdentity: false, specifier: './type-only.ts' },
            { kind: 'import-equals', requiresRuntimeIdentity: true, specifier: './import-equals.ts' }
        ]);
    });

    it('fails closed for malformed and unsupported source files', () => {
        expect(() => readModuleReferences('fixture.ts', 'import {')).toThrow(/fixture\.ts/);
        expect(() => readModuleReferences('fixture.vue', 'const value = 1;')).toThrow(/unsupported/i);
    });

    it.each([
        'const target = \'./auth-login-service.ts\'; import(target);',
        'const target = \'./auth-login-service.ts\'; require(target);'
    ])('fails closed for a direct nonliteral module reference: %s', (source) => {
        expect(() => readModuleReferences('reviewer-fixture.ts', source)).toThrow(/nonliteral/i);
    });
});

it('fails closed when an allowlisted source is omitted from the scanned inventory', () => {
    const missingPath = 'apps/api-v1/src/config-repo.ts';
    const remainingAllowlistedPaths = [
        'apps/api-v1/test/operations/rtc-persisted-state-migration.test.ts',
        'apps/relic-hunter-server-v1/src/config-repo.ts',
        'packages/shared-test/black-box-runner/rallar-browser-rtc-provider.ts',
        'packages/shared-test/black-box-runner/utils.ts',
        'packages/tests/hetzner/cloudflare-main-only-branch-controls.test.ts',
        'packages/tests/repo/auth-mutation-validation-ownership.test.ts',
        'packages/tests/shared-web/shared-web-browser-entrypoints.test.ts'
    ];

    expect(() =>
        readAuthCompatibilityConsumers({
            readSource: readRepositorySource,
            sourcePaths: remainingAllowlistedPaths
        })
    ).toThrow(`${missingPath}: missing allowlisted source path`);
});

describe('compatibility consumer ownership maps', () => {
    it('fails closed when an allowlisted nonliteral reference is removed', () => {
        const fixturePath = 'apps/api-v1/src/config-repo.ts';

        expect(() =>
            readAuthCompatibilityConsumers({
                readSource: () => 'export const fileName = \'./config.ts\';',
                sourcePaths: [fixturePath]
            })
        ).toThrow(/missing allowlisted nonliteral module reference: dynamic:fileName/i);
    });

    it('fails closed when an end-to-end scan sees a fragmented nonliteral wrapper reference', () => {
        const fixturePath = 'packages/tests/repo/fragmented-wrapper-reference.ts';
        const source = 'require(\'../../shared-server/rallar-system/services/auth-login-\' + \'service.ts\');';

        expect(() =>
            readAuthCompatibilityConsumers({
                readSource: () => source,
                sourcePaths: [fixturePath]
            })
        ).toThrow(/nonliteral/i);
    });

    it('keeps every canonical auth test free of compatibility wrappers', () => {
        const compatibilitySpecifiers = new Set(
            authCompatibilityConsumerInventory.map(({ compatibilityPath }) => compatibilityPath.replace('packages/shared-server/', '@shared-server/'))
        );
        const compatibilityReferences = readdirSync(canonicalAuthTestRoot)
            .filter((name) => name.endsWith('.test.ts'))
            .flatMap((name) => {
                const filePath = `${canonicalAuthTestRoot}/${name}`;
                return readModuleReferences(filePath, readRepositorySource(filePath))
                    .filter(({ specifier }) => compatibilitySpecifiers.has(specifier))
                    .map(({ specifier }) => `${filePath}:${specifier}`);
            });

        expect(compatibilityReferences).toEqual([]);
    });

    it('keeps all consumers and runtime-identity consumers explicit', () => {
        const consumers = readAuthCompatibilityConsumers();
        const identityConsumers = readAuthCompatibilityIdentityConsumers();
        const governanceIdentityConsumers = readAuthCompatibilityGovernanceIdentityConsumers();
        for (const inventory of authCompatibilityConsumerInventory) {
            expect(consumers.get(inventory.compatibilityPath)).toEqual(inventory.consumers);
            expect(identityConsumers.get(inventory.compatibilityPath)).toEqual(
                inventory.identityConsumers
            );
            expect(governanceIdentityConsumers.get(inventory.compatibilityPath)).toEqual(
                inventory.governanceIdentityConsumers
            );
            expect(inventory.governanceIdentityConsumers).toEqual([runtimeIdentityGovernanceTest]);
        }
    }, 15_000);
});

function readRepositorySource(filePath: string): string {
    return readFileSync(path.join(process.cwd(), filePath), 'utf8');
}

function withOverrides(overrides: ReadonlyMap<string, string>): (filePath: string) => string {
    return (filePath) => overrides.get(filePath) ?? readRepositorySource(filePath);
}
