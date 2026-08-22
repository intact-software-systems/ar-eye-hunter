import { describe, expect, it } from 'vitest';

import {
    createRallarOntologyCatalog,
    getRallarOntologyBindingProfiles,
    getRallarOntologyBindings,
    getRallarOntologyTerm,
    RALLAR_RELATION_IDS,
    validateRallarOntologyCatalog,
    type CreateRallarOntologyCatalogInput,
    type RallarDomainOntologyTerm,
    type RallarMessageOntologyBindingProfile,
    type RallarMessageOntologyTerm,
    type RallarOntologyBindingModule,
    type RallarOntologyVocabularyModule,
    type RallarRtcLaneOntologyTerm
} from '@shared/ontology/mod.ts';

import {
    createRallarOntologyBindingModuleFixture,
    createRallarOntologyCustomOrderedProfileFixture,
    createRallarOntologySpecializedCopyFixture,
    createRallarOntologyVocabularyFixture,
    ONTOLOGY_BASE,
    TEST_BINDING_ID,
    TEST_BINDING_SET_ID,
    TEST_CHILD_TERM_ID,
    TEST_ONTOLOGY_ID,
    TEST_PARENT_TERM_ID,
    TEST_PROFILE_ID,
    type RallarOntologyCustomOrderedProfile
} from './rallar-ontology-test-fixtures.ts';

const ALPHA_BINDING_SET_ID = `${ONTOLOGY_BASE}/binding-set/acme.alpha` as const;
const ALPHA_BINDING_ID = `${ONTOLOGY_BASE}/binding/acme.alpha.export` as const;
const ALPHA_PROFILE_ID = `${ONTOLOGY_BASE}/binding-profile/acme.alpha.profile` as const;
const SECOND_BINDING_ID = `${ONTOLOGY_BASE}/binding/acme.core.second` as const;
const SECOND_PROFILE_ID = `${ONTOLOGY_BASE}/binding-profile/acme.core.second` as const;

function createUnsortedVocabulary(): RallarOntologyVocabularyModule {
    const fixture = createRallarOntologyVocabularyFixture();
    const domainTerm: RallarDomainOntologyTerm = {
        ...fixture.terms[0],
        kind: 'domain',
        domainKind: 'identity',
        authority: 'authoritative',
        identityFields: ['z-authored-first', 'a-authored-second']
    };
    return createRallarOntologyVocabularyFixture({
        version: '0.3.0',
        versionIri: `${TEST_ONTOLOGY_ID}/version/0.3.0`,
        compatibleWith: [`${TEST_ONTOLOGY_ID}/version/0.2.0`, `${TEST_ONTOLOGY_ID}/version/0.1.0`],
        requiredVocabularyVersionIris: [
            `${ONTOLOGY_BASE}/code-standards/version/0.1.0`,
            `${ONTOLOGY_BASE}/domain/version/0.1.0`
        ],
        competencyQuestionIds: ['CQ-z-last', 'CQ-a-first'],
        terms: [
            {
                ...fixture.terms[1],
                references: [
                    { relationId: RALLAR_RELATION_IDS.scopedBy, targetTermId: TEST_PARENT_TERM_ID },
                    { relationId: RALLAR_RELATION_IDS.identifies, targetTermId: TEST_PARENT_TERM_ID }
                ]
            },
            {
                ...domainTerm
            }
        ]
    });
}

function createAlphaBindingSet(): RallarOntologyBindingModule {
    const fixture = createRallarOntologyBindingModuleFixture();
    return createRallarOntologyBindingModuleFixture({
        bindingSetId: ALPHA_BINDING_SET_ID,
        vocabularyVersionIri: `${TEST_ONTOLOGY_ID}/version/0.3.0`,
        versionIri: `${ALPHA_BINDING_SET_ID}/version/0.1.0`,
        bindings: [{ ...fixture.bindings[0], bindingId: ALPHA_BINDING_ID }],
        profiles: [{ ...fixture.profiles[0], profileId: ALPHA_PROFILE_ID }]
    });
}

function createRequiredVocabulary(
    ontologyId: RallarOntologyVocabularyModule['ontologyId'],
    termId: RallarOntologyVocabularyModule['terms'][number]['termId']
): RallarOntologyVocabularyModule {
    return createRallarOntologyVocabularyFixture({
        ontologyId,
        versionIri: `${ontologyId}/version/0.1.0`,
        terms: [
            {
                ...createRallarOntologyVocabularyFixture().terms[0],
                termId,
                references: []
            }
        ]
    });
}

function createUnsortedBindingSet(): RallarOntologyBindingModule {
    const fixture = createRallarOntologyBindingModuleFixture();
    return createRallarOntologyBindingModuleFixture({
        vocabularyVersionIri: `${TEST_ONTOLOGY_ID}/version/0.3.0`,
        version: '0.3.0',
        versionIri: `${TEST_BINDING_SET_ID}/version/0.3.0`,
        compatibleWith: [
            `${TEST_BINDING_SET_ID}/version/0.2.0`,
            `${TEST_BINDING_SET_ID}/version/0.1.0`
        ],
        bindings: [
            {
                ...fixture.bindings[0],
                bindingId: SECOND_BINDING_ID,
                termId: TEST_CHILD_TERM_ID,
                target: {
                    kind: 'wire-constant',
                    modulePath: 'packages/shared/example.ts',
                    exportName: 'EXAMPLE',
                    propertyPath: ['zAuthoredFirst', 'aAuthoredSecond']
                }
            },
            fixture.bindings[0]
        ],
        profiles: [
            { ...fixture.profiles[0], profileId: SECOND_PROFILE_ID, termId: TEST_CHILD_TERM_ID },
            fixture.profiles[0]
        ]
    });
}

function createUnsortedInput(): CreateRallarOntologyCatalogInput {
    return {
        vocabularies: [
            createUnsortedVocabulary(),
            createRequiredVocabulary(`${ONTOLOGY_BASE}/domain`, `${ONTOLOGY_BASE}/term/domain.example`),
            createRequiredVocabulary(
                `${ONTOLOGY_BASE}/code-standards`,
                `${ONTOLOGY_BASE}/term/code-rule.example`
            )
        ],
        bindingSets: [createUnsortedBindingSet(), createAlphaBindingSet()]
    };
}

function freezeInputGraph(value: unknown): void {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
        return;
    }
    Object.values(value).forEach(freezeInputGraph);
    Object.freeze(value);
}

function expectDetachedCopy(copied: unknown, authored: unknown): void {
    expect(copied).toEqual(authored);
    expect(copied).not.toBe(authored);
}

describe('Rallar ontology registry', () => {
    it('creates the same deterministic catalog from forward and reverse module order', () => {
        const input = createUnsortedInput();
        const reversed = {
            vocabularies: [...input.vocabularies].reverse(),
            bindingSets: [...input.bindingSets].reverse()
        };

        expect(createRallarOntologyCatalog(input)).toEqual(createRallarOntologyCatalog(reversed));
    });

    it('sorts every order-insensitive collection by raw identity ordering', () => {
        const catalog = createRallarOntologyCatalog(createUnsortedInput());
        const source = catalog.vocabularies.find(
            (vocabulary) => vocabulary.ontologyId === TEST_ONTOLOGY_ID
        );

        expect(catalog.vocabularies.map((vocabulary) => vocabulary.ontologyId)).toEqual([
            `${ONTOLOGY_BASE}/code-standards`,
            `${ONTOLOGY_BASE}/domain`,
            TEST_ONTOLOGY_ID
        ]);
        expect(source?.compatibleWith).toEqual([
            `${TEST_ONTOLOGY_ID}/version/0.1.0`,
            `${TEST_ONTOLOGY_ID}/version/0.2.0`
        ]);
        expect(source?.requiredVocabularyVersionIris).toEqual([
            `${ONTOLOGY_BASE}/code-standards/version/0.1.0`,
            `${ONTOLOGY_BASE}/domain/version/0.1.0`
        ]);
        expect(source?.competencyQuestionIds).toEqual(['CQ-a-first', 'CQ-z-last']);
        expect(source?.terms.map((term) => term.termId)).toEqual([
            TEST_CHILD_TERM_ID,
            TEST_PARENT_TERM_ID
        ]);
        expect(source?.terms[0]?.references.map((reference) => reference.relationId)).toEqual([
            RALLAR_RELATION_IDS.identifies,
            RALLAR_RELATION_IDS.scopedBy
        ]);
        expect(catalog.bindingSets.map((bindingSet) => bindingSet.bindingSetId)).toEqual([
            ALPHA_BINDING_SET_ID,
            TEST_BINDING_SET_ID
        ]);
        expect(
            catalog.bindingSets.map((bindingSet) => bindingSet.bindings.map((item) => item.bindingId))
        ).toEqual([[ALPHA_BINDING_ID], [TEST_BINDING_ID, SECOND_BINDING_ID]]);
        expect(
            catalog.bindingSets.map((bindingSet) => bindingSet.profiles.map((item) => item.profileId))
        ).toEqual([[ALPHA_PROFILE_ID], [TEST_PROFILE_ID, SECOND_PROFILE_ID]]);
        expect(catalog.bindings.map((binding) => binding.bindingId)).toEqual([
            ALPHA_BINDING_ID,
            TEST_BINDING_ID,
            SECOND_BINDING_ID
        ]);
        expect(catalog.bindingProfiles.map((profile) => profile.profileId)).toEqual([
            ALPHA_PROFILE_ID,
            TEST_PROFILE_ID,
            SECOND_PROFILE_ID
        ]);
        expect(catalog.terms.map((term) => term.termId)).toEqual(
            [...catalog.terms.map((term) => term.termId)].sort()
        );
    });

    it('does not mutate caller arrays and preserves semantically ordered arrays', () => {
        const input = createUnsortedInput();
        const before = structuredClone(input);
        freezeInputGraph(input);

        const catalog = createRallarOntologyCatalog(input);
        const source = catalog.vocabularies.find(
            (vocabulary) => vocabulary.ontologyId === TEST_ONTOLOGY_ID
        );
        const parent = source?.terms.find((term) => term.termId === TEST_PARENT_TERM_ID);
        const wireBinding = catalog.bindings.find((binding) => binding.bindingId === SECOND_BINDING_ID);

        expect(input).toEqual(before);
        expect(parent).toMatchObject({
            identityFields: ['z-authored-first', 'a-authored-second']
        });
        expect(wireBinding?.target).toMatchObject({
            propertyPath: ['zAuthoredFirst', 'aAuthoredSecond']
        });
        if (wireBinding?.target.kind === 'wire-constant') {
            const authoredWireBinding = input.bindingSets[0]?.bindings.find(
                (binding) => binding.bindingId === SECOND_BINDING_ID
            );
            expect(wireBinding.target.propertyPath).not.toBe(
                authoredWireBinding?.target.kind === 'wire-constant'
                    ? authoredWireBinding.target.propertyPath
                    : undefined
            );
        }
    });

    it('copies every known ordered value without reordering or mutating caller data', () => {
        const fixture = createRallarOntologySpecializedCopyFixture();
        const input = { vocabularies: [fixture.vocabulary], bindingSets: [fixture.bindingSet] };
        const before = structuredClone(input);
        freezeInputGraph(input);

        const catalog = createRallarOntologyCatalog(input);
        const copiedDomain = getRallarOntologyTerm(
            catalog,
            fixture.domainTerm.termId
        ) as RallarDomainOntologyTerm;
        const copiedMessage = getRallarOntologyTerm(
            catalog,
            fixture.messageTerm.termId
        ) as RallarMessageOntologyTerm;
        const copiedLane = getRallarOntologyTerm(
            catalog,
            fixture.laneTerm.termId
        ) as RallarRtcLaneOntologyTerm;
        const copiedProfile = getRallarOntologyBindingProfiles(
            catalog,
            fixture.messageProfile.termId
        ).find(
            (profile) => profile.profileId === fixture.messageProfile.profileId
        ) as RallarMessageOntologyBindingProfile;

        expect(input).toEqual(before);
        expectDetachedCopy(copiedDomain, fixture.domainTerm);
        expectDetachedCopy(copiedDomain.identityFields, fixture.domainTerm.identityFields);
        expectDetachedCopy(copiedMessage, fixture.messageTerm);
        expectDetachedCopy(copiedMessage.routes, fixture.messageTerm.routes);
        expectDetachedCopy(copiedMessage.routes[0], fixture.messageTerm.routes[0]);
        expectDetachedCopy(
            copiedMessage.routes[0].transports,
            fixture.messageTerm.routes[0].transports
        );
        expectDetachedCopy(
            copiedMessage.routes[0].targetModes,
            fixture.messageTerm.routes[0].targetModes
        );
        expectDetachedCopy(copiedMessage.senderKinds, fixture.messageTerm.senderKinds);
        expectDetachedCopy(copiedMessage.validation, fixture.messageTerm.validation);
        if (
            copiedMessage.validation.kind === 'runtime-payload' &&
            fixture.messageTerm.validation.kind === 'runtime-payload'
        ) {
            expectDetachedCopy(
                copiedMessage.validation.schemaVersion,
                fixture.messageTerm.validation.schemaVersion
            );
        }
        expectDetachedCopy(copiedLane, fixture.laneTerm);
        expectDetachedCopy(copiedLane.payloadKinds, fixture.laneTerm.payloadKinds);
        expectDetachedCopy(copiedProfile, fixture.messageProfile);
        expectDetachedCopy(copiedProfile.routeBindings, fixture.messageProfile.routeBindings);
        const copiedRoute = copiedProfile.routeBindings[0];
        const authoredRoute = fixture.messageProfile.routeBindings[0];
        expectDetachedCopy(copiedRoute, authoredRoute);
        expectDetachedCopy(copiedRoute.authorizationBindings, authoredRoute.authorizationBindings);
        expectDetachedCopy(
            copiedRoute.authorizationBindings[0],
            authoredRoute.authorizationBindings[0]
        );
        expectDetachedCopy(
            copiedRoute.authorizationBindings[0].ownerBindingIds,
            authoredRoute.authorizationBindings[0].ownerBindingIds
        );
        expectDetachedCopy(copiedProfile.validation, fixture.messageProfile.validation);
        const copiedBinding = catalog.bindings[0];
        const authoredBinding = fixture.bindingSet.bindings[0];
        if (
            copiedBinding.target.kind === 'wire-constant' &&
            authoredBinding.target.kind === 'wire-constant'
        ) {
            expectDetachedCopy(copiedBinding.target.propertyPath, authoredBinding.target.propertyPath);
        }
    });

    it('detaches custom profile nested ordered arrays from later caller mutation', () => {
        const authoredSteps = ['zAuthoredFirst', 'aAuthoredSecond'];
        const profile = createRallarOntologyCustomOrderedProfileFixture(authoredSteps);
        const bindingSet = createRallarOntologyBindingModuleFixture({ profiles: [profile] });
        const catalog = createRallarOntologyCatalog({
            vocabularies: [createRallarOntologyVocabularyFixture()],
            bindingSets: [bindingSet]
        });
        const copied = catalog.bindingProfiles[0] as RallarOntologyCustomOrderedProfile;

        authoredSteps.reverse();

        expect(copied.metadata.orderedSteps).toEqual(['zAuthoredFirst', 'aAuthoredSecond']);
        expect(copied.metadata).not.toBe(profile.metadata);
        expect(copied.metadata.orderedSteps).not.toBe(authoredSteps);
    });

    it('provides direct term, binding, and profile lookups with empty missing results', () => {
        const catalog = createRallarOntologyCatalog(createUnsortedInput());

        expect(getRallarOntologyTerm(catalog, TEST_PARENT_TERM_ID)?.termId).toBe(TEST_PARENT_TERM_ID);
        expect(getRallarOntologyBindings(catalog, TEST_PARENT_TERM_ID)).toHaveLength(2);
        expect(getRallarOntologyBindingProfiles(catalog, TEST_PARENT_TERM_ID)).toHaveLength(2);
        const missing = `${ONTOLOGY_BASE}/term/acme.missing` as const;
        expect(getRallarOntologyTerm(catalog, missing)).toBeUndefined();
        expect(getRallarOntologyBindings(catalog, missing)).toEqual([]);
        expect(getRallarOntologyBindingProfiles(catalog, missing)).toEqual([]);
    });

    it('creates an independently valid vocabulary catalog without bindings', () => {
        const catalog = createRallarOntologyCatalog({
            vocabularies: [createRallarOntologyVocabularyFixture()],
            bindingSets: []
        });

        expect(catalog.bindingSets).toEqual([]);
        expect(catalog.bindings).toEqual([]);
        expect(catalog.bindingProfiles).toEqual([]);
    });

    it('throws one TypeError containing every sorted validation issue', () => {
        const vocabulary = createRallarOntologyVocabularyFixture({
            terms: [
                {
                    ...createRallarOntologyVocabularyFixture().terms[0],
                    references: [
                        {
                            relationId: RALLAR_RELATION_IDS.scopedBy,
                            targetTermId: `${ONTOLOGY_BASE}/term/acme.missing`
                        }
                    ]
                }
            ]
        });
        const input = { vocabularies: [vocabulary, vocabulary], bindingSets: [] };
        const issues = validateRallarOntologyCatalog(input);

        expect(() => createRallarOntologyCatalog(input)).toThrowError(TypeError);
        try {
            createRallarOntologyCatalog(input);
        }
        catch (error) {
            expect(error).toBeInstanceOf(TypeError);
            const message = String(error);
            issues.forEach((issue) => {
                expect(message).toContain(`${issue.path} [${issue.code}]: ${issue.message}`);
            });
        }
    });
});
