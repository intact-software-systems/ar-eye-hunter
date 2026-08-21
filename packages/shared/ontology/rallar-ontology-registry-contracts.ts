import type {
    RallarOntologyBinding,
    RallarOntologyBindingModule,
    RallarOntologyBindingProfileBase,
    RallarOntologyTermBase,
    RallarOntologyVocabularyModule
} from './rallar-ontology-contracts.ts';

export interface RallarOntologyIssue {
    readonly code:
        | 'invalid-ontology-iri'
        | 'invalid-version'
        | 'invalid-version-iri'
        | 'invalid-term-iri'
        | 'invalid-owner-iri'
        | 'invalid-relation-iri'
        | 'duplicate-ontology-id'
        | 'duplicate-version-iri'
        | 'duplicate-term-id'
        | 'duplicate-binding-set-id'
        | 'duplicate-binding-id'
        | 'duplicate-binding-profile-id'
        | 'invalid-maturity'
        | 'invalid-compatible-version-iri'
        | 'invalid-binding-target'
        | 'invalid-binding-strength'
        | 'missing-vocabulary-import'
        | 'binding-vocabulary-version-mismatch'
        | 'missing-reference'
        | 'missing-binding-term'
        | 'invalid-deprecation';
    readonly path: string;
    readonly message: string;
}

export interface CreateRallarOntologyCatalogInput {
    readonly vocabularies: readonly RallarOntologyVocabularyModule[];
    readonly bindingSets: readonly RallarOntologyBindingModule[];
}

export interface RallarOntologyCatalog {
    readonly vocabularies: readonly RallarOntologyVocabularyModule[];
    readonly bindingSets: readonly RallarOntologyBindingModule[];
    readonly terms: readonly RallarOntologyTermBase[];
    readonly bindings: readonly RallarOntologyBinding[];
    readonly bindingProfiles: readonly RallarOntologyBindingProfileBase[];
}
