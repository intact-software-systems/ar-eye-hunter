import { describe, expect, it } from 'vitest';

import {
    RALLAR_RELATION_IDS,
    type RallarOntologyBindingModule,
    type RallarOntologyTermBase,
    type RallarOntologyVersion,
    type RallarOntologyVocabularyModule
} from '@shared/ontology/rallar-ontology-contracts.ts';
import { validateRallarOntologyCatalog } from '@shared/ontology/validate-rallar-ontology-catalog.ts';

import {
    createRallarOntologyBindingModuleFixture,
    createRallarOntologyVocabularyFixture,
    ONTOLOGY_BASE,
    TEST_CHILD_TERM_ID,
    TEST_ONTOLOGY_ID,
    TEST_ONTOLOGY_VERSION_IRI,
    TEST_PARENT_TERM_ID
} from './rallar-ontology-test-fixtures.ts';

const DEPENDENCY_ONTOLOGY_ID = `${ONTOLOGY_BASE}/extension/acme/dependency` as const;
const DEPENDENCY_TERM_ID = `${ONTOLOGY_BASE}/term/acme.dependency` as const;

function createDependencyVocabulary(
    version: RallarOntologyVersion = '0.1.0',
    overrides: Partial<RallarOntologyVocabularyModule> = {}
): RallarOntologyVocabularyModule {
    return createRallarOntologyVocabularyFixture({
        ontologyId: DEPENDENCY_ONTOLOGY_ID,
        version,
        versionIri: `${DEPENDENCY_ONTOLOGY_ID}/version/${version}`,
        terms: [
            {
                termId: DEPENDENCY_TERM_ID,
                kind: 'concept',
                label: 'Dependency',
                definition: 'A dependency concept.',
                status: 'draft',
                references: []
            }
        ],
        ...overrides
    });
}

function createSourceVocabulary(
    term: RallarOntologyTermBase,
    requiredVocabularyVersionIris: RallarOntologyVocabularyModule['requiredVocabularyVersionIris'] = []
): RallarOntologyVocabularyModule {
    return createRallarOntologyVocabularyFixture({
        requiredVocabularyVersionIris,
        terms: [term]
    });
}

function sourceTerm(overrides: Partial<RallarOntologyTermBase> = {}): RallarOntologyTermBase {
    return {
        ...createRallarOntologyVocabularyFixture().terms[0],
        ...overrides
    };
}

function codes(input: {
    readonly vocabularies: readonly RallarOntologyVocabularyModule[];
    readonly bindingSets: readonly RallarOntologyBindingModule[];
}): readonly string[] {
    return validateRallarOntologyCatalog(input).map((issue) => issue.code);
}

describe('Rallar ontology catalog validation', () => {
    it('accepts the exact independent vocabulary and binding pair', () => {
        expect(
            validateRallarOntologyCatalog({
                vocabularies: [createRallarOntologyVocabularyFixture()],
                bindingSets: [createRallarOntologyBindingModuleFixture()]
            })
        ).toEqual([]);
    });

    it('reports duplicate identities across every catalog collection', () => {
        const vocabulary = createRallarOntologyVocabularyFixture();
        const bindingSet = createRallarOntologyBindingModuleFixture();
        const duplicateTermVocabulary = createDependencyVocabulary('0.1.0', {
            terms: [{ ...vocabulary.terms[0], termId: TEST_PARENT_TERM_ID }]
        });
        const duplicateBindingSet = createRallarOntologyBindingModuleFixture({
            bindings: [bindingSet.bindings[0]],
            profiles: [bindingSet.profiles[0]]
        });
        const issues = validateRallarOntologyCatalog({
            vocabularies: [vocabulary, vocabulary, duplicateTermVocabulary],
            bindingSets: [bindingSet, duplicateBindingSet]
        });

        expect(issues.map((issue) => issue.code)).toEqual(
            expect.arrayContaining([
                'duplicate-ontology-id',
                'duplicate-version-iri',
                'duplicate-term-id',
                'duplicate-binding-set-id',
                'duplicate-binding-id',
                'duplicate-binding-profile-id'
            ])
        );
        expect(issues.every((issue) => issue.path.startsWith('catalog.'))).toBe(true);
    });

    it('accepts an exact selected vocabulary dependency', () => {
        const dependency = createDependencyVocabulary();
        const source = createSourceVocabulary(sourceTerm(), [dependency.versionIri]);

        expect(
            validateRallarOntologyCatalog({ vocabularies: [source, dependency], bindingSets: [] })
        ).toEqual([]);
    });

    it('accepts a newer selected dependency only with explicit prior compatibility', () => {
        const requiredVersionIri = `${DEPENDENCY_ONTOLOGY_ID}/version/0.1.0` as const;
        const dependency = createDependencyVocabulary('0.2.0', {
            compatibleWith: [requiredVersionIri]
        });
        const source = createSourceVocabulary(sourceTerm(), [requiredVersionIri]);

        expect(
            validateRallarOntologyCatalog({ vocabularies: [source, dependency], bindingSets: [] })
        ).toEqual([]);
    });

    it.each([
        { selected: [] },
        { selected: [createDependencyVocabulary('0.2.0')] },
        {
            selected: [
                createDependencyVocabulary('0.2.0', {
                    compatibleWith: [`${DEPENDENCY_ONTOLOGY_ID}/version/0.0.1`]
                })
            ]
        }
    ])('rejects an omitted or incompatible selected dependency %#', ({ selected }) => {
        const source = createSourceVocabulary(sourceTerm(), [
            `${DEPENDENCY_ONTOLOGY_ID}/version/0.1.0`
        ]);

        expect(codes({ vocabularies: [source, ...selected], bindingSets: [] })).toContain(
            'missing-vocabulary-import'
        );
    });

    it('accepts intra-vocabulary references without declaring a dependency', () => {
        const source = createRallarOntologyVocabularyFixture();

        expect(validateRallarOntologyCatalog({ vocabularies: [source], bindingSets: [] })).toEqual([]);
    });

    it('accepts foreign references and supersession only with a satisfied dependency', () => {
        const dependency = createDependencyVocabulary();
        const source = createSourceVocabulary(
            sourceTerm({
                status: 'deprecated',
                removalCondition: 'Remove after dependency migration.',
                supersededBy: DEPENDENCY_TERM_ID,
                references: [
                    { relationId: RALLAR_RELATION_IDS.scopedBy, targetTermId: DEPENDENCY_TERM_ID }
                ]
            }),
            [dependency.versionIri]
        );

        expect(
            validateRallarOntologyCatalog({ vocabularies: [source, dependency], bindingSets: [] })
        ).toEqual([]);
    });

    it('distinguishes absent references from undeclared foreign references', () => {
        const missing = createSourceVocabulary(
            sourceTerm({
                references: [
                    {
                        relationId: RALLAR_RELATION_IDS.scopedBy,
                        targetTermId: `${ONTOLOGY_BASE}/term/acme.absent`
                    }
                ]
            })
        );
        const foreign = createSourceVocabulary(
            sourceTerm({
                references: [
                    { relationId: RALLAR_RELATION_IDS.scopedBy, targetTermId: DEPENDENCY_TERM_ID }
                ]
            })
        );

        expect(codes({ vocabularies: [missing], bindingSets: [] })).toContain('missing-reference');
        expect(
            codes({ vocabularies: [foreign, createDependencyVocabulary()], bindingSets: [] })
        ).toContain('missing-vocabulary-import');
    });

    it('requires exact binding ontology and selected vocabulary-version pairing', () => {
        const bindingSet = createRallarOntologyBindingModuleFixture({
            vocabularyVersionIri: `${TEST_ONTOLOGY_ID}/version/0.2.0`
        });

        expect(
            codes({
                vocabularies: [createRallarOntologyVocabularyFixture()],
                bindingSets: [bindingSet]
            })
        ).toContain('binding-vocabulary-version-mismatch');
    });

    it('rejects a binding or profile term owned by another selected vocabulary', () => {
        const original = createRallarOntologyBindingModuleFixture();
        const bindingSet = createRallarOntologyBindingModuleFixture({
            bindings: [{ ...original.bindings[0], termId: DEPENDENCY_TERM_ID }],
            profiles: [{ ...original.profiles[0], termId: DEPENDENCY_TERM_ID }]
        });

        expect(
            codes({
                vocabularies: [createRallarOntologyVocabularyFixture(), createDependencyVocabulary()],
                bindingSets: [bindingSet]
            })
        ).toEqual(expect.arrayContaining(['missing-binding-term', 'missing-binding-term']));
    });

    it('reports every untrusted binding target failure with complete catalog paths', () => {
        const runtimeBindingSet = JSON.parse(
            JSON.stringify(createRallarOntologyBindingModuleFixture())
        );
        const binding = runtimeBindingSet.bindings[0];
        runtimeBindingSet.bindings = [
            { ...binding, target: { ...binding.target, kind: 'typescript-export-typo' } },
            {
                ...binding,
                bindingId: `${ONTOLOGY_BASE}/binding/acme.invalid-package-target`,
                target: { kind: 'typescript-export', modulePath: 'lodash/fp', exportName: 'map' }
            }
        ];

        expect(
            validateRallarOntologyCatalog({
                vocabularies: [createRallarOntologyVocabularyFixture()],
                bindingSets: [runtimeBindingSet]
            })
        ).toEqual([
            {
                code: 'invalid-binding-target',
                path: 'catalog.bindingSets[0].bindings[0].target.kind',
                message: 'Binding target kind is not supported.'
            },
            {
                code: 'invalid-binding-target',
                path: 'catalog.bindingSets[0].bindings[1].target.modulePath',
                message: 'Target path must be safe and repository-relative.'
            }
        ]);
    });

    it('returns complete catalog paths in deterministic path, code, message order', () => {
        const source = createSourceVocabulary(
            sourceTerm({
                termId: TEST_CHILD_TERM_ID,
                references: [
                    {
                        relationId: RALLAR_RELATION_IDS.scopedBy,
                        targetTermId: `${ONTOLOGY_BASE}/term/acme.absent`
                    }
                ]
            })
        );
        const issues = validateRallarOntologyCatalog({
            vocabularies: [createRallarOntologyVocabularyFixture(), source],
            bindingSets: [
                createRallarOntologyBindingModuleFixture({
                    vocabularyVersionIri: `${TEST_ONTOLOGY_ID}/version/0.2.0`
                })
            ]
        });
        const tuples = issues.map((issue) => `${issue.path}\u0000${issue.code}\u0000${issue.message}`);

        expect(tuples).toEqual([...tuples].sort());
        expect(issues.some((issue) => issue.path.includes('catalog.vocabularies[1].terms[0]'))).toBe(
            true
        );
        expect(issues.some((issue) => issue.path.includes('catalog.bindingSets[0]'))).toBe(true);
        expect(issues.every((issue) => !/^(termId|targetTermId|modulePath)$/u.test(issue.path))).toBe(
            true
        );
        expect(TEST_ONTOLOGY_VERSION_IRI).toContain('/version/0.1.0');
    });
});
