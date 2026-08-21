import { describe, expect, it } from 'vitest';

import { RALLAR_RELATION_IDS, type RallarOntologyVocabularyModule } from '@shared/ontology/rallar-ontology-contracts.ts';
import { validateRallarOntologyVocabularyModule } from '@shared/ontology/validate-rallar-ontology-vocabulary-module.ts';

import {
    createRallarOntologyVocabularyFixture,
    ONTOLOGY_BASE,
    TEST_CHILD_TERM_ID,
    TEST_ONTOLOGY_ID,
    TEST_OWNER_ID,
    TEST_PARENT_TERM_ID
} from './rallar-ontology-test-fixtures.ts';

function issueCodes(vocabulary: RallarOntologyVocabularyModule): readonly string[] {
    return validateRallarOntologyVocabularyModule(vocabulary).map((issue) => issue.code);
}

describe('Rallar ontology vocabulary validation', () => {
    it('accepts the independent default vocabulary without a binding module', () => {
        expect(validateRallarOntologyVocabularyModule(createRallarOntologyVocabularyFixture())).toEqual(
            []
        );
    });

    it.each([
        `${ONTOLOGY_BASE}/domain`,
        `${ONTOLOGY_BASE}/realtime`,
        `${ONTOLOGY_BASE}/code-standards`,
        `${ONTOLOGY_BASE}/extension/acme/game`
    ])('accepts the governed ontology series %s', (ontologyId) => {
        const versionIri = `${ontologyId}/version/0.1.0`;
        const vocabulary = createRallarOntologyVocabularyFixture({
            ontologyId: ontologyId as RallarOntologyVocabularyModule['ontologyId'],
            versionIri: versionIri as RallarOntologyVocabularyModule['versionIri']
        });

        expect(validateRallarOntologyVocabularyModule(vocabulary)).toEqual([]);
    });

    it('accepts canonical owner, term, relation, and version identities', () => {
        const vocabulary = createRallarOntologyVocabularyFixture({
            ownerId: `${ONTOLOGY_BASE}/owner/acme`,
            terms: [
                {
                    termId: `${ONTOLOGY_BASE}/term/acme.entity`,
                    kind: 'concept',
                    label: 'Entity',
                    definition: 'An entity.',
                    status: 'draft',
                    references: [
                        {
                            relationId: `${ONTOLOGY_BASE}/relation/scoped-by`,
                            targetTermId: TEST_PARENT_TERM_ID
                        }
                    ]
                }
            ]
        });

        expect(validateRallarOntologyVocabularyModule(vocabulary)).toEqual([]);
    });

    it.each(
        [
            'http://www.w3.org/2004/02/skos/core#broader',
            'http://www.w3.org/2004/02/skos/core#narrower',
            'http://www.w3.org/2004/02/skos/core#related'
        ] as const
    )('accepts the controlled SKOS relation %s', (relationId) => {
        const vocabulary = createRallarOntologyVocabularyFixture({
            terms: [
                {
                    ...createRallarOntologyVocabularyFixture().terms[0],
                    references: [{ relationId, targetTermId: TEST_PARENT_TERM_ID }]
                }
            ]
        });

        expect(validateRallarOntologyVocabularyModule(vocabulary)).toEqual([]);
    });

    it.each([
        'http://github.com/intact-software-systems/ar-eye-hunter/ontology/domain',
        'https://GITHUB.com/intact-software-systems/ar-eye-hunter/ontology/domain',
        'https://githуb.com/intact-software-systems/ar-eye-hunter/ontology/domain',
        'https://github.com.evil/intact-software-systems/ar-eye-hunter/ontology/domain',
        'https://github.com@evil.example/intact-software-systems/ar-eye-hunter/ontology/domain',
        'https://github.com/intact-software-systems/ar-eye-hunter/ontology.evil/domain',
        `${ONTOLOGY_BASE}/./domain`,
        `${ONTOLOGY_BASE}/../domain`,
        `${ONTOLOGY_BASE}//domain`,
        `${ONTOLOGY_BASE}/domain?version=1`,
        `${ONTOLOGY_BASE}/domain#version`,
        `${ONTOLOGY_BASE}/%64omain`,
        `${ONTOLOGY_BASE}/extension`,
        `${ONTOLOGY_BASE}/extension/acme`
    ])('rejects the literal ontology lookalike %s', (ontologyId) => {
        const vocabulary = createRallarOntologyVocabularyFixture({
            ontologyId: ontologyId as RallarOntologyVocabularyModule['ontologyId']
        });

        expect(issueCodes(vocabulary)).toContain('invalid-ontology-iri');
    });

    it.each([
        ['ownerId', `${ONTOLOGY_BASE}/owner/../acme`, 'invalid-owner-iri'],
        ['ownerId', `${ONTOLOGY_BASE}/owner/acme?x=1`, 'invalid-owner-iri'],
        ['ownerId', `${ONTOLOGY_BASE}/owner/%61cme`, 'invalid-owner-iri'],
        ['termId', `${ONTOLOGY_BASE}/term/../acme.entity`, 'invalid-term-iri'],
        ['termId', `${ONTOLOGY_BASE}/term/acme.entity#x`, 'invalid-term-iri'],
        ['termId', `${ONTOLOGY_BASE}/term/%61cme.entity`, 'invalid-term-iri']
    ])('rejects malformed %s identities', (field, value, code) => {
        const vocabulary = createRallarOntologyVocabularyFixture(
            field === 'ownerId'
                ? { ownerId: value as RallarOntologyVocabularyModule['ownerId'] }
                : {
                    terms: [
                        {
                            ...createRallarOntologyVocabularyFixture().terms[0],
                            termId: value as RallarOntologyVocabularyModule['terms'][number]['termId']
                        }
                    ]
                }
        );

        expect(issueCodes(vocabulary)).toContain(code);
    });

    it.each(['1', '1.2', '1.2.3-beta', '1.2.3+build', '01.2.3', '1.02.3', '1.2.03'])(
        'rejects the non-canonical version %s',
        (version) => {
            const vocabulary = createRallarOntologyVocabularyFixture({
                version: version as RallarOntologyVocabularyModule['version']
            });

            expect(issueCodes(vocabulary)).toContain('invalid-version');
        }
    );

    it('requires the exact version IRI for the declared series and version', () => {
        const vocabulary = createRallarOntologyVocabularyFixture({
            versionIri: `${TEST_ONTOLOGY_ID}/version/0.2.0`
        });

        expect(issueCodes(vocabulary)).toContain('invalid-version-iri');
    });

    it('accepts unique prior compatible versions from the same series', () => {
        const vocabulary = createRallarOntologyVocabularyFixture({
            version: '0.3.0',
            versionIri: `${TEST_ONTOLOGY_ID}/version/0.3.0`,
            compatibleWith: [`${TEST_ONTOLOGY_ID}/version/0.1.0`, `${TEST_ONTOLOGY_ID}/version/0.2.0`]
        });

        expect(validateRallarOntologyVocabularyModule(vocabulary)).toEqual([]);
    });

    it.each([
        {
            compatibleWith: [`${TEST_ONTOLOGY_ID}/version/0.1.0`, `${TEST_ONTOLOGY_ID}/version/0.1.0`]
        },
        { compatibleWith: [`${TEST_ONTOLOGY_ID}/version/0.3.0`] },
        { compatibleWith: [`${TEST_ONTOLOGY_ID}/version/0.4.0`] },
        { compatibleWith: [`${ONTOLOGY_BASE}/extension/acme/other/version/0.1.0`] },
        { compatibleWith: [`${TEST_ONTOLOGY_ID}/version/^0.1.0`] },
        { compatibleWith: [`${TEST_ONTOLOGY_ID}/version/0.1`] },
        { compatibleWith: [`${TEST_ONTOLOGY_ID}/version/0.1.0-beta`] },
        { compatibleWith: [`${TEST_ONTOLOGY_ID}/version/0.1.0+build`] },
        { compatibleWith: [`${TEST_ONTOLOGY_ID}/version/00.1.0`] }
    ])('rejects an invalid compatibility declaration %#', ({ compatibleWith }) => {
        const vocabulary = createRallarOntologyVocabularyFixture({
            version: '0.3.0',
            versionIri: `${TEST_ONTOLOGY_ID}/version/0.3.0`,
            compatibleWith: compatibleWith as RallarOntologyVocabularyModule['compatibleWith']
        });

        expect(issueCodes(vocabulary)).toContain('invalid-compatible-version-iri');
    });

    it('validates controlled relations, unique terms, maturity, and local deprecation rules', () => {
        const parent = createRallarOntologyVocabularyFixture().terms[0];
        const vocabulary = createRallarOntologyVocabularyFixture({
            maturity: 'preview' as RallarOntologyVocabularyModule['maturity'],
            terms: [
                parent,
                { ...parent, termId: parent.termId },
                {
                    ...parent,
                    termId: TEST_CHILD_TERM_ID,
                    status: 'deprecated',
                    supersededBy: TEST_CHILD_TERM_ID,
                    references: [
                        {
                            relationId: `${ONTOLOGY_BASE}/relation/free-form` as typeof RALLAR_RELATION_IDS.scopedBy,
                            targetTermId: TEST_PARENT_TERM_ID
                        }
                    ]
                }
            ]
        });
        const issues = validateRallarOntologyVocabularyModule(vocabulary);

        expect(issues.map((issue) => issue.code)).toEqual(
            expect.arrayContaining([
                'invalid-maturity',
                'duplicate-term-id',
                'invalid-relation-iri',
                'invalid-deprecation'
            ])
        );
        expect(issues.every((issue) => issue.path.startsWith('vocabulary.'))).toBe(true);
        expect(issues.some((issue) => issue.path === 'vocabulary.terms[2].supersededBy')).toBe(true);
    });

    it('leaves valid reference target resolution to catalog validation', () => {
        const vocabulary = createRallarOntologyVocabularyFixture({
            terms: [
                {
                    ...createRallarOntologyVocabularyFixture().terms[0],
                    references: [
                        {
                            relationId: RALLAR_RELATION_IDS.scopedBy,
                            targetTermId: `${ONTOLOGY_BASE}/term/acme.not-selected`
                        }
                    ]
                }
            ]
        });

        expect(validateRallarOntologyVocabularyModule(vocabulary)).toEqual([]);
    });
});
