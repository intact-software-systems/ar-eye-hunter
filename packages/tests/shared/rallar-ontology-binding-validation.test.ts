import { describe, expect, it } from 'vitest';

import type { RallarOntologyBinding, RallarOntologyBindingModule, RallarOntologyBindingTarget } from '@shared/ontology/rallar-ontology-contracts.ts';
import { validateRallarOntologyBindingModule } from '@shared/ontology/validate-rallar-ontology-binding-module.ts';

import {
    createRallarOntologyBindingModuleFixture,
    ONTOLOGY_BASE,
    TEST_BINDING_ID,
    TEST_BINDING_SET_ID,
    TEST_BINDING_SET_VERSION_IRI,
    TEST_ONTOLOGY_ID,
    TEST_ONTOLOGY_VERSION_IRI,
    TEST_OWNER_ID,
    TEST_PARENT_TERM_ID,
    TEST_PROFILE_ID
} from './rallar-ontology-test-fixtures.ts';

function bindingFixture(
    target: RallarOntologyBindingTarget,
    overrides: Partial<RallarOntologyBinding> = {}
): RallarOntologyBinding {
    return {
        ...createRallarOntologyBindingModuleFixture().bindings[0],
        target,
        ...overrides
    };
}

function issueCodes(bindingSet: RallarOntologyBindingModule): readonly string[] {
    return validateRallarOntologyBindingModule(bindingSet).map((issue) => issue.code);
}

describe('Rallar ontology binding validation', () => {
    it('accepts the independent default binding module with canonical identities', () => {
        const bindingSet = createRallarOntologyBindingModuleFixture();

        expect(bindingSet).toMatchObject({
            bindingSetId: TEST_BINDING_SET_ID,
            ontologyId: TEST_ONTOLOGY_ID,
            vocabularyVersionIri: TEST_ONTOLOGY_VERSION_IRI,
            ownerId: TEST_OWNER_ID,
            version: '0.1.0',
            versionIri: TEST_BINDING_SET_VERSION_IRI
        });
        expect(bindingSet.bindings[0]?.bindingId).toBe(TEST_BINDING_ID);
        expect(bindingSet.profiles[0]?.profileId).toBe(TEST_PROFILE_ID);
        expect(validateRallarOntologyBindingModule(bindingSet)).toEqual([]);
    });

    it.each([
        'http://github.com/intact-software-systems/ar-eye-hunter/ontology/binding-set/acme.core',
        'https://GITHUB.com/intact-software-systems/ar-eye-hunter/ontology/binding-set/acme.core',
        'https://github.com.evil/intact-software-systems/ar-eye-hunter/ontology/binding-set/acme.core',
        `${ONTOLOGY_BASE}/binding-set/../acme.core`,
        `${ONTOLOGY_BASE}/binding-set/acme.core?x=1`,
        `${ONTOLOGY_BASE}/binding-set/%61cme.core`
    ])('rejects the literal binding-set lookalike %s', (bindingSetId) => {
        const bindingSet = createRallarOntologyBindingModuleFixture({
            bindingSetId: bindingSetId as RallarOntologyBindingModule['bindingSetId']
        });

        expect(issueCodes(bindingSet)).toContain('invalid-ontology-iri');
    });

    it('requires exact binding and vocabulary version IRIs', () => {
        const bindingSet = createRallarOntologyBindingModuleFixture({
            versionIri: `${TEST_BINDING_SET_ID}/version/0.2.0`,
            vocabularyVersionIri: `${ONTOLOGY_BASE}/extension/acme/other/version/0.1.0`
        });

        expect(issueCodes(bindingSet)).toEqual(
            expect.arrayContaining(['invalid-version-iri', 'invalid-version-iri'])
        );
    });

    it.each(['1', '1.2', '1.2.3-beta', '1.2.3+build', '01.2.3'])(
        'rejects non-canonical binding version %s',
        (version) => {
            const bindingSet = createRallarOntologyBindingModuleFixture({
                version: version as RallarOntologyBindingModule['version']
            });

            expect(issueCodes(bindingSet)).toContain('invalid-version');
        }
    );

    it('accepts unique prior compatible binding versions from the same series', () => {
        const bindingSet = createRallarOntologyBindingModuleFixture({
            version: '0.3.0',
            versionIri: `${TEST_BINDING_SET_ID}/version/0.3.0`,
            compatibleWith: [
                `${TEST_BINDING_SET_ID}/version/0.1.0`,
                `${TEST_BINDING_SET_ID}/version/0.2.0`
            ]
        });

        expect(validateRallarOntologyBindingModule(bindingSet)).toEqual([]);
    });

    it.each([
        {
            values: [`${TEST_BINDING_SET_ID}/version/0.1.0`, `${TEST_BINDING_SET_ID}/version/0.1.0`]
        },
        { values: [`${TEST_BINDING_SET_ID}/version/0.3.0`] },
        { values: [`${TEST_BINDING_SET_ID}/version/0.4.0`] },
        { values: [`${ONTOLOGY_BASE}/binding-set/acme.other/version/0.1.0`] },
        { values: [`${TEST_BINDING_SET_ID}/version/^0.1.0`] },
        { values: [`${TEST_BINDING_SET_ID}/version/0.1`] },
        { values: [`${TEST_BINDING_SET_ID}/version/0.1.0-beta`] },
        { values: [`${TEST_BINDING_SET_ID}/version/0.1.0+build`] },
        { values: [`${TEST_BINDING_SET_ID}/version/00.1.0`] }
    ])('rejects an invalid binding compatibility declaration %#', ({ values }) => {
        const bindingSet = createRallarOntologyBindingModuleFixture({
            version: '0.3.0',
            versionIri: `${TEST_BINDING_SET_ID}/version/0.3.0`,
            compatibleWith: values as RallarOntologyBindingModule['compatibleWith']
        });

        expect(issueCodes(bindingSet)).toContain('invalid-compatible-version-iri');
    });

    it('rejects invalid maturity and duplicate binding or profile identities', () => {
        const original = createRallarOntologyBindingModuleFixture();
        const bindingSet = createRallarOntologyBindingModuleFixture({
            maturity: 'preview' as RallarOntologyBindingModule['maturity'],
            bindings: [original.bindings[0], original.bindings[0]],
            profiles: [original.profiles[0], original.profiles[0]]
        });

        expect(issueCodes(bindingSet)).toEqual(
            expect.arrayContaining([
                'invalid-maturity',
                'duplicate-binding-id',
                'duplicate-binding-profile-id'
            ])
        );
    });

    it.each(
        [
            {
                kind: 'typescript-export',
                modulePath: 'packages/shared/example.ts',
                exportName: 'Example'
            },
            {
                kind: 'wire-constant',
                modulePath: 'packages/shared/example.ts',
                exportName: 'EXAMPLE',
                propertyPath: ['id']
            },
            {
                kind: 'openapi-component',
                documentPath: 'apps/api-v1/resources/api-v1-openapi.yaml',
                componentName: 'Example'
            },
            {
                kind: 'runtime-validator',
                modulePath: 'packages/shared/example.ts',
                exportName: 'validateExample',
                validatorId: 'example-v1'
            },
            {
                kind: 'normative-anchor',
                documentPath: 'docs/example.md',
                anchor: 'example'
            },
            {
                kind: 'export-property',
                modulePath: 'packages/shared/example.ts',
                exportName: 'example',
                propertyName: 'id'
            },
            { kind: 'package-script', manifestPath: 'package.json', scriptName: 'test:unit' },
            { kind: 'repository-owner', ownerId: TEST_OWNER_ID, path: 'packages/shared' },
            { kind: 'implementation-symbol', path: 'packages/shared/example.ts', symbol: 'example' },
            { kind: 'example', path: 'examples/example.ts' }
        ] satisfies readonly RallarOntologyBindingTarget[]
    )(
        'accepts the $kind target contract',
        (target) => {
            const strengths = ['contractual', 'owner', 'implementation', 'example'] as const;
            const bindings = strengths.map((strength, index) =>
                bindingFixture(target, {
                    bindingId: `${ONTOLOGY_BASE}/binding/acme.target-${index}`,
                    strength
                })
            );

            expect(
                validateRallarOntologyBindingModule(createRallarOntologyBindingModuleFixture({ bindings }))
            ).toEqual([]);
        }
    );

    it('rejects an untrusted target with an unsupported kind at the target boundary', () => {
        const runtimeBindingSet = JSON.parse(
            JSON.stringify(createRallarOntologyBindingModuleFixture())
        );
        runtimeBindingSet.bindings[0].target.kind = 'typescript-export-typo';

        expect(validateRallarOntologyBindingModule(runtimeBindingSet)).toEqual([
            {
                code: 'invalid-binding-target',
                path: 'bindingSet.bindings[0].target.kind',
                message: 'Binding target kind is not supported.'
            }
        ]);
    });

    it('rejects an unscoped package specifier as a repository target path', () => {
        const bindingSet = createRallarOntologyBindingModuleFixture({
            bindings: [
                bindingFixture({ kind: 'typescript-export', modulePath: 'lodash/fp', exportName: 'map' })
            ]
        });

        expect(validateRallarOntologyBindingModule(bindingSet)).toEqual([
            {
                code: 'invalid-binding-target',
                path: 'bindingSet.bindings[0].target.modulePath',
                message: 'Target path must be safe and repository-relative.'
            }
        ]);
    });

    it.each([
        '/packages/shared/example.ts',
        '../packages/shared/example.ts',
        'packages/../shared/example.ts',
        'https://example.test/file.ts',
        '@shared/example.ts',
        'packages/shared/%65xample.ts',
        'packages/shared/__proto__/example.ts',
        'packages/shared/prototype/example.ts',
        'packages/shared/constructor/example.ts'
    ])('rejects the unsafe repository target %s', (modulePath) => {
        const bindingSet = createRallarOntologyBindingModuleFixture({
            bindings: [bindingFixture({ kind: 'typescript-export', modulePath, exportName: 'Example' })]
        });
        const issues = validateRallarOntologyBindingModule(bindingSet);

        expect(issues.map((issue) => issue.code)).toContain('invalid-binding-target');
        expect(issues[0]?.path).toContain('bindingSet.bindings[0].target.modulePath');
    });

    it.each(['', '__proto__', 'prototype', 'constructor', 'not.valid'])(
        'rejects unsafe property path segment %s',
        (propertyName) => {
            const bindingSet = createRallarOntologyBindingModuleFixture({
                bindings: [
                    bindingFixture({
                        kind: 'wire-constant',
                        modulePath: 'packages/shared/example.ts',
                        exportName: 'EXAMPLE',
                        propertyPath: [propertyName]
                    })
                ]
            });

            expect(issueCodes(bindingSet)).toContain('invalid-binding-target');
        }
    );

    it('rejects malformed governed binding identities and invalid strengths with full paths', () => {
        const original = createRallarOntologyBindingModuleFixture();
        const bindingSet = createRallarOntologyBindingModuleFixture({
            bindings: [
                {
                    ...original.bindings[0],
                    bindingId: `${ONTOLOGY_BASE}/binding/../bad`,
                    termId: `${ONTOLOGY_BASE}/term/../bad`,
                    strength: 'strong' as RallarOntologyBinding['strength']
                }
            ],
            profiles: [
                {
                    ...original.profiles[0],
                    profileId: `${ONTOLOGY_BASE}/binding-profile/bad?x=1`,
                    termId: `${ONTOLOGY_BASE}/term/%62ad`
                }
            ]
        });
        const issues = validateRallarOntologyBindingModule(bindingSet);

        expect(issues.map((issue) => issue.code)).toEqual(
            expect.arrayContaining([
                'invalid-ontology-iri',
                'invalid-term-iri',
                'invalid-binding-strength'
            ])
        );
        expect(issues.every((issue) => issue.path.startsWith('bindingSet.'))).toBe(true);
        expect(issues.some((issue) => issue.path === 'bindingSet.profiles[0].profileId')).toBe(true);
    });
});
