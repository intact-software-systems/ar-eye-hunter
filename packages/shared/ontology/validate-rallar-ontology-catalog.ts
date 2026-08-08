import type {
  RallarOntologyBindingModule,
  RallarOntologyTermBase,
  RallarOntologyVersionIri,
  RallarOntologyVocabularyModule,
} from './rallar-ontology-contracts.ts';
import {
  createRallarOntologyIssue,
  sortRallarOntologyIssues,
} from './rallar-ontology-identity-validation.ts';
import type {
  CreateRallarOntologyCatalogInput,
  RallarOntologyIssue,
} from './rallar-ontology-registry-contracts.ts';
import { validateRallarOntologyBindingModule } from './validate-rallar-ontology-binding-module.ts';
import * as vocabularyValidation from './validate-rallar-ontology-vocabulary-module.ts';

interface OwnedTerm {
  readonly term: RallarOntologyTermBase;
  readonly vocabulary: RallarOntologyVocabularyModule;
}

interface AddDuplicateIssueInput {
  readonly seen: Set<string>;
  readonly value: string;
  readonly code: RallarOntologyIssue['code'];
  readonly path: string;
  readonly issues: RallarOntologyIssue[];
}

interface ValidateDeclaredDependenciesInput {
  readonly source: RallarOntologyVocabularyModule;
  readonly sourceIndex: number;
  readonly vocabularies: readonly RallarOntologyVocabularyModule[];
  readonly issues: RallarOntologyIssue[];
}

interface ValidateTermReferenceInput {
  readonly source: RallarOntologyVocabularyModule;
  readonly targetTermId: string;
  readonly path: string;
  readonly termsById: ReadonlyMap<string, OwnedTerm>;
  readonly issues: RallarOntologyIssue[];
}

interface AddMissingBindingTermInput {
  readonly ownedTermIds: ReadonlySet<string>;
  readonly termId: string;
  readonly path: string;
  readonly issues: RallarOntologyIssue[];
}

export function validateRallarOntologyCatalog(
  input: CreateRallarOntologyCatalogInput,
): readonly RallarOntologyIssue[] {
  const issues: RallarOntologyIssue[] = [];
  collectStandaloneIssues(input, issues);
  validateCatalogIdentities(input, issues);
  const termsById = toTermsById(input.vocabularies);
  validateVocabularyDependenciesAndReferences(input.vocabularies, termsById, issues);
  validateBindingVocabularyOwnership(input, issues);
  return sortRallarOntologyIssues(issues);
}

function collectStandaloneIssues(
  input: CreateRallarOntologyCatalogInput,
  issues: RallarOntologyIssue[],
): void {
  input.vocabularies.forEach((vocabulary, index) => {
    const prefix = `catalog.vocabularies[${index}]`;
    issues.push(
      ...vocabularyValidation.validateRallarOntologyVocabularyModule(vocabulary).map((issue) => ({
        ...issue,
        path: issue.path.replace(/^vocabulary/u, prefix),
      })),
    );
  });
  input.bindingSets.forEach((bindingSet, index) => {
    const prefix = `catalog.bindingSets[${index}]`;
    issues.push(
      ...validateRallarOntologyBindingModule(bindingSet).map((issue) => ({
        ...issue,
        path: issue.path.replace(/^bindingSet/u, prefix),
      })),
    );
  });
}

function validateCatalogIdentities(
  input: CreateRallarOntologyCatalogInput,
  issues: RallarOntologyIssue[],
): void {
  addVocabularyDuplicateIssues(input.vocabularies, issues);
  addBindingDuplicateIssues(input.bindingSets, issues);
}

function addVocabularyDuplicateIssues(
  vocabularies: readonly RallarOntologyVocabularyModule[],
  issues: RallarOntologyIssue[],
): void {
  const ontologyIds = new Set<string>();
  const versionIris = new Set<string>();
  const termIds = new Set<string>();
  vocabularies.forEach((vocabulary, vocabularyIndex) => {
    addDuplicateIssue({
      seen: ontologyIds,
      value: vocabulary.ontologyId,
      code: 'duplicate-ontology-id',
      path: `catalog.vocabularies[${vocabularyIndex}].ontologyId`,
      issues,
    });
    addDuplicateIssue({
      seen: versionIris,
      value: vocabulary.versionIri,
      code: 'duplicate-version-iri',
      path: `catalog.vocabularies[${vocabularyIndex}].versionIri`,
      issues,
    });
    vocabulary.terms.forEach((term, termIndex) =>
      addDuplicateIssue({
        seen: termIds,
        value: term.termId,
        code: 'duplicate-term-id',
        path: `catalog.vocabularies[${vocabularyIndex}].terms[${termIndex}].termId`,
        issues,
      }),
    );
  });
}

function addBindingDuplicateIssues(
  bindingSets: readonly RallarOntologyBindingModule[],
  issues: RallarOntologyIssue[],
): void {
  const bindingSetIds = new Set<string>();
  const bindingIds = new Set<string>();
  const profileIds = new Set<string>();
  bindingSets.forEach((bindingSet, bindingSetIndex) => {
    addDuplicateIssue({
      seen: bindingSetIds,
      value: bindingSet.bindingSetId,
      code: 'duplicate-binding-set-id',
      path: `catalog.bindingSets[${bindingSetIndex}].bindingSetId`,
      issues,
    });
    bindingSet.bindings.forEach((binding, bindingIndex) =>
      addDuplicateIssue({
        seen: bindingIds,
        value: binding.bindingId,
        code: 'duplicate-binding-id',
        path: `catalog.bindingSets[${bindingSetIndex}].bindings[${bindingIndex}].bindingId`,
        issues,
      }),
    );
    bindingSet.profiles.forEach((profile, profileIndex) =>
      addDuplicateIssue({
        seen: profileIds,
        value: profile.profileId,
        code: 'duplicate-binding-profile-id',
        path: `catalog.bindingSets[${bindingSetIndex}].profiles[${profileIndex}].profileId`,
        issues,
      }),
    );
  });
}

function addDuplicateIssue(input: AddDuplicateIssueInput): void {
  if (input.seen.has(input.value)) {
    input.issues.push(
      createRallarOntologyIssue(
        input.code,
        input.path,
        `${input.value} is selected more than once.`,
      ),
    );
  }
  input.seen.add(input.value);
}

function toTermsById(
  vocabularies: readonly RallarOntologyVocabularyModule[],
): ReadonlyMap<string, OwnedTerm> {
  const termsById = new Map<string, OwnedTerm>();
  vocabularies.forEach((vocabulary) =>
    vocabulary.terms.forEach((term) => {
      if (!termsById.has(term.termId)) {
        termsById.set(term.termId, { term, vocabulary });
      }
    }),
  );
  return termsById;
}

function validateVocabularyDependenciesAndReferences(
  vocabularies: readonly RallarOntologyVocabularyModule[],
  termsById: ReadonlyMap<string, OwnedTerm>,
  issues: RallarOntologyIssue[],
): void {
  vocabularies.forEach((vocabulary, vocabularyIndex) => {
    validateDeclaredDependencies({
      source: vocabulary,
      sourceIndex: vocabularyIndex,
      vocabularies,
      issues,
    });
    vocabulary.terms.forEach((term, termIndex) => {
      const termPath = `catalog.vocabularies[${vocabularyIndex}].terms[${termIndex}]`;
      term.references.forEach((reference, referenceIndex) =>
        validateTermReference({
          source: vocabulary,
          targetTermId: reference.targetTermId,
          path: `${termPath}.references[${referenceIndex}].targetTermId`,
          termsById,
          issues,
        }),
      );
      if (term.supersededBy !== undefined && term.supersededBy !== term.termId) {
        validateTermReference({
          source: vocabulary,
          targetTermId: term.supersededBy,
          path: `${termPath}.supersededBy`,
          termsById,
          issues,
        });
      }
    });
  });
}

function validateDeclaredDependencies(input: ValidateDeclaredDependenciesInput): void {
  input.source.requiredVocabularyVersionIris.forEach((requiredVersionIri, requirementIndex) => {
    const seriesId = seriesFromVersionIri(requiredVersionIri);
    const selected = input.vocabularies.find((candidate) => candidate.ontologyId === seriesId);
    if (selected === undefined || !vocabularySatisfies(selected, requiredVersionIri)) {
      const requirementPath =
        `catalog.vocabularies[${input.sourceIndex}]` +
        `.requiredVocabularyVersionIris[${requirementIndex}]`;
      input.issues.push(
        createRallarOntologyIssue(
          'missing-vocabulary-import',
          requirementPath,
          `No selected vocabulary satisfies ${requiredVersionIri}.`,
        ),
      );
    }
  });
}

function validateTermReference(input: ValidateTermReferenceInput): void {
  const ownedTarget = input.termsById.get(input.targetTermId);
  if (ownedTarget === undefined) {
    input.issues.push(
      createRallarOntologyIssue(
        'missing-reference',
        input.path,
        `Referenced term ${input.targetTermId} is not selected.`,
      ),
    );
    return;
  }
  if (
    ownedTarget.vocabulary.ontologyId !== input.source.ontologyId &&
    !hasSatisfiedDependency(input.source, ownedTarget.vocabulary)
  ) {
    input.issues.push(
      createRallarOntologyIssue(
        'missing-vocabulary-import',
        input.path,
        `Reference to ${input.targetTermId} requires an explicit satisfied vocabulary dependency.`,
      ),
    );
  }
}

function hasSatisfiedDependency(
  source: RallarOntologyVocabularyModule,
  target: RallarOntologyVocabularyModule,
): boolean {
  return source.requiredVocabularyVersionIris.some(
    (requiredVersionIri) =>
      seriesFromVersionIri(requiredVersionIri) === target.ontologyId &&
      vocabularySatisfies(target, requiredVersionIri),
  );
}

function vocabularySatisfies(
  vocabulary: RallarOntologyVocabularyModule,
  requiredVersionIri: RallarOntologyVersionIri,
): boolean {
  return (
    vocabulary.versionIri === requiredVersionIri ||
    vocabulary.compatibleWith.includes(requiredVersionIri)
  );
}

function seriesFromVersionIri(versionIri: string): string {
  const markerIndex = versionIri.lastIndexOf('/version/');
  return markerIndex < 0 ? '' : versionIri.slice(0, markerIndex);
}

function validateBindingVocabularyOwnership(
  input: CreateRallarOntologyCatalogInput,
  issues: RallarOntologyIssue[],
): void {
  input.bindingSets.forEach((bindingSet, bindingSetIndex) => {
    const vocabulary = input.vocabularies.find(
      (candidate) =>
        candidate.ontologyId === bindingSet.ontologyId &&
        candidate.versionIri === bindingSet.vocabularyVersionIri,
    );
    if (vocabulary === undefined) {
      issues.push(
        createRallarOntologyIssue(
          'binding-vocabulary-version-mismatch',
          `catalog.bindingSets[${bindingSetIndex}].vocabularyVersionIri`,
          'Binding module must select the exact ontology ID and vocabulary version IRI.',
        ),
      );
      return;
    }
    const termIds = new Set(vocabulary.terms.map((term) => term.termId));
    bindingSet.bindings.forEach((binding, bindingIndex) =>
      addMissingBindingTerm({
        ownedTermIds: termIds,
        termId: binding.termId,
        path: `catalog.bindingSets[${bindingSetIndex}].bindings[${bindingIndex}].termId`,
        issues,
      }),
    );
    bindingSet.profiles.forEach((profile, profileIndex) =>
      addMissingBindingTerm({
        ownedTermIds: termIds,
        termId: profile.termId,
        path: `catalog.bindingSets[${bindingSetIndex}].profiles[${profileIndex}].termId`,
        issues,
      }),
    );
  });
}

function addMissingBindingTerm(input: AddMissingBindingTermInput): void {
  if (!input.ownedTermIds.has(input.termId)) {
    input.issues.push(
      createRallarOntologyIssue(
        'missing-binding-term',
        input.path,
        `Binding term ${input.termId} does not belong to the selected vocabulary version.`,
      ),
    );
  }
}
