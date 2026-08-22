import { RALLAR_RELATION_IDS, type RallarOntologyVocabularyModule } from './rallar-ontology-contracts.ts';
import {
    createRallarOntologyIssue,
    isCanonicalRallarOntologyVersion,
    isValidRallarOntologyId,
    isValidRallarOntologyOwnerId,
    isValidRallarOntologyRelationId,
    isValidRallarOntologyTermId,
    isVersionIriForSeries,
    sortRallarOntologyIssues,
    validateCompatibleVersionIris
} from './rallar-ontology-identity-validation.ts';
import type { RallarOntologyIssue } from './rallar-ontology-registry-contracts.ts';

const skosRelationIds = [
    'http://www.w3.org/2004/02/skos/core#broader',
    'http://www.w3.org/2004/02/skos/core#narrower',
    'http://www.w3.org/2004/02/skos/core#related'
] as const;
const controlledRelationIds = new Set<string>([
    ...Object.values(RALLAR_RELATION_IDS),
    ...skosRelationIds
]);

export function validateRallarOntologyVocabularyModule(
    vocabulary: RallarOntologyVocabularyModule
): readonly RallarOntologyIssue[] {
    const issues: RallarOntologyIssue[] = [];
    validateVocabularyIdentity(vocabulary, issues);
    validateVocabularyMetadata(vocabulary, issues);
    validateVocabularyTerms(vocabulary, issues);
    return sortRallarOntologyIssues(issues);
}

function validateVocabularyIdentity(
    vocabulary: RallarOntologyVocabularyModule,
    issues: RallarOntologyIssue[]
): void {
    if (!isValidRallarOntologyId(vocabulary.ontologyId)) {
        issues.push(
            createRallarOntologyIssue(
                'invalid-ontology-iri',
                'vocabulary.ontologyId',
                'Ontology ID must be a literal governed ontology series IRI.'
            )
        );
    }
    if (!isValidRallarOntologyOwnerId(vocabulary.ownerId)) {
        issues.push(
            createRallarOntologyIssue(
                'invalid-owner-iri',
                'vocabulary.ownerId',
                'Owner ID must be a literal governed owner IRI.'
            )
        );
    }
    if (!isCanonicalRallarOntologyVersion(vocabulary.version)) {
        issues.push(
            createRallarOntologyIssue(
                'invalid-version',
                'vocabulary.version',
                'Version must be a canonical numeric major.minor.patch value.'
            )
        );
    }
    if (vocabulary.versionIri !== `${vocabulary.ontologyId}/version/${vocabulary.version}`) {
        issues.push(
            createRallarOntologyIssue(
                'invalid-version-iri',
                'vocabulary.versionIri',
                'Version IRI must exactly combine ontologyId and version.'
            )
        );
    }
}

function validateVocabularyMetadata(
    vocabulary: RallarOntologyVocabularyModule,
    issues: RallarOntologyIssue[]
): void {
    if (vocabulary.maturity !== 'experimental' && vocabulary.maturity !== 'stable') {
        issues.push(
            createRallarOntologyIssue(
                'invalid-maturity',
                'vocabulary.maturity',
                'Maturity must be experimental or stable.'
            )
        );
    }
    issues.push(
        ...validateCompatibleVersionIris({
            seriesId: vocabulary.ontologyId,
            version: vocabulary.version,
            values: vocabulary.compatibleWith,
            path: 'vocabulary.compatibleWith'
        })
    );
    vocabulary.requiredVocabularyVersionIris.forEach((versionIri, index) => {
        const ownerSeries = versionIri.slice(0, versionIri.lastIndexOf('/version/'));
        if (!isValidRallarOntologyId(ownerSeries) || !isVersionIriForSeries(versionIri, ownerSeries)) {
            issues.push(
                createRallarOntologyIssue(
                    'invalid-version-iri',
                    `vocabulary.requiredVocabularyVersionIris[${index}]`,
                    'Required vocabulary version must be an exact governed version IRI.'
                )
            );
        }
    });
}

function validateVocabularyTerms(
    vocabulary: RallarOntologyVocabularyModule,
    issues: RallarOntologyIssue[]
): void {
    const termIds = new Set<string>();
    vocabulary.terms.forEach((term, termIndex) => {
        const path = `vocabulary.terms[${termIndex}]`;
        if (!isValidRallarOntologyTermId(term.termId)) {
            issues.push(
                createRallarOntologyIssue(
                    'invalid-term-iri',
                    `${path}.termId`,
                    'Term ID must be a literal governed term IRI.'
                )
            );
        }
        if (termIds.has(term.termId)) {
            issues.push(
                createRallarOntologyIssue(
                    'duplicate-term-id',
                    `${path}.termId`,
                    'Term IDs must be unique.'
                )
            );
        }
        termIds.add(term.termId);
        validateTermReferences(term, path, issues);
        validateTermDeprecation(term, path, issues);
    });
}

function validateTermReferences(
    term: RallarOntologyVocabularyModule['terms'][number],
    termPath: string,
    issues: RallarOntologyIssue[]
): void {
    term.references.forEach((reference, referenceIndex) => {
        const path = `${termPath}.references[${referenceIndex}]`;
        if (
            !isValidRallarOntologyRelationId(reference.relationId) ||
            !controlledRelationIds.has(reference.relationId)
        ) {
            issues.push(
                createRallarOntologyIssue(
                    'invalid-relation-iri',
                    `${path}.relationId`,
                    'Relation ID must be one of the controlled Rallar or SKOS relations.'
                )
            );
        }
        if (!isValidRallarOntologyTermId(reference.targetTermId)) {
            issues.push(
                createRallarOntologyIssue(
                    'invalid-term-iri',
                    `${path}.targetTermId`,
                    'Reference target must be a literal governed term IRI.'
                )
            );
        }
    });
}

function validateTermDeprecation(
    term: RallarOntologyVocabularyModule['terms'][number],
    termPath: string,
    issues: RallarOntologyIssue[]
): void {
    if (term.status === 'deprecated' && !term.removalCondition?.trim()) {
        issues.push(
            createRallarOntologyIssue(
                'invalid-deprecation',
                `${termPath}.removalCondition`,
                'A deprecated term requires a non-empty removal condition.'
            )
        );
    }
    if (term.supersededBy !== undefined) {
        if (!isValidRallarOntologyTermId(term.supersededBy) || term.supersededBy === term.termId) {
            issues.push(
                createRallarOntologyIssue(
                    'invalid-deprecation',
                    `${termPath}.supersededBy`,
                    'A superseding term must be a different valid governed term IRI.'
                )
            );
        }
    }
}
