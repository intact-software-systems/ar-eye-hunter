import type {
  RallarOntologyBinding,
  RallarOntologyBindingModule,
  RallarOntologyBindingTarget,
} from './rallar-ontology-contracts.ts';
import {
  createRallarOntologyIssue,
  isCanonicalRallarOntologyVersion,
  isRepositoryRelativeOntologyTarget,
  isSafeOntologyPropertySegment,
  isValidRallarOntologyBindingId,
  isValidRallarOntologyBindingProfileId,
  isValidRallarOntologyBindingSetId,
  isValidRallarOntologyId,
  isValidRallarOntologyOwnerId,
  isValidRallarOntologyTermId,
  isVersionIriForSeries,
  sortRallarOntologyIssues,
  validateCompatibleVersionIris,
} from './rallar-ontology-identity-validation.ts';
import type { RallarOntologyIssue } from './rallar-ontology-registry-contracts.ts';

const bindingStrengths = new Set(['contractual', 'owner', 'implementation', 'example']);

interface AddInvalidIdentityInput {
  readonly invalid: boolean;
  readonly path: string;
  readonly message: string;
  readonly issues: RallarOntologyIssue[];
}

export function validateRallarOntologyBindingModule(
  bindingSet: RallarOntologyBindingModule,
): readonly RallarOntologyIssue[] {
  const issues: RallarOntologyIssue[] = [];
  validateBindingModuleIdentity(bindingSet, issues);
  validateBindingModuleMetadata(bindingSet, issues);
  validateBindings(bindingSet, issues);
  validateProfiles(bindingSet, issues);
  return sortRallarOntologyIssues(issues);
}

function validateBindingModuleIdentity(
  bindingSet: RallarOntologyBindingModule,
  issues: RallarOntologyIssue[],
): void {
  addInvalidIdentity({
    invalid: !isValidRallarOntologyBindingSetId(bindingSet.bindingSetId),
    path: 'bindingSet.bindingSetId',
    message: 'Binding-set ID must be a literal governed binding-set IRI.',
    issues,
  });
  addInvalidIdentity({
    invalid: !isValidRallarOntologyId(bindingSet.ontologyId),
    path: 'bindingSet.ontologyId',
    message: 'Ontology ID must be a literal governed ontology series IRI.',
    issues,
  });
  if (!isVersionIriForSeries(bindingSet.vocabularyVersionIri, bindingSet.ontologyId)) {
    issues.push(
      createRallarOntologyIssue(
        'invalid-version-iri',
        'bindingSet.vocabularyVersionIri',
        'Vocabulary version IRI must belong to the declared ontology series.',
      ),
    );
  }
  if (!isValidRallarOntologyOwnerId(bindingSet.ownerId)) {
    issues.push(
      createRallarOntologyIssue(
        'invalid-owner-iri',
        'bindingSet.ownerId',
        'Owner ID must be a literal governed owner IRI.',
      ),
    );
  }
  if (!isCanonicalRallarOntologyVersion(bindingSet.version)) {
    issues.push(
      createRallarOntologyIssue(
        'invalid-version',
        'bindingSet.version',
        'Version must be a canonical numeric major.minor.patch value.',
      ),
    );
  }
  if (bindingSet.versionIri !== `${bindingSet.bindingSetId}/version/${bindingSet.version}`) {
    issues.push(
      createRallarOntologyIssue(
        'invalid-version-iri',
        'bindingSet.versionIri',
        'Version IRI must exactly combine bindingSetId and version.',
      ),
    );
  }
}

function validateBindingModuleMetadata(
  bindingSet: RallarOntologyBindingModule,
  issues: RallarOntologyIssue[],
): void {
  if (bindingSet.maturity !== 'experimental' && bindingSet.maturity !== 'stable') {
    issues.push(
      createRallarOntologyIssue(
        'invalid-maturity',
        'bindingSet.maturity',
        'Maturity must be experimental or stable.',
      ),
    );
  }
  issues.push(
    ...validateCompatibleVersionIris({
      seriesId: bindingSet.bindingSetId,
      version: bindingSet.version,
      values: bindingSet.compatibleWith,
      path: 'bindingSet.compatibleWith',
    }),
  );
}

function validateBindings(
  bindingSet: RallarOntologyBindingModule,
  issues: RallarOntologyIssue[],
): void {
  const bindingIds = new Set<string>();
  bindingSet.bindings.forEach((binding, bindingIndex) => {
    const path = `bindingSet.bindings[${bindingIndex}]`;
    addInvalidIdentity({
      invalid: !isValidRallarOntologyBindingId(binding.bindingId),
      path: `${path}.bindingId`,
      message: 'Binding ID must be a literal governed binding IRI.',
      issues,
    });
    if (bindingIds.has(binding.bindingId)) {
      issues.push(
        createRallarOntologyIssue(
          'duplicate-binding-id',
          `${path}.bindingId`,
          'Binding IDs must be unique.',
        ),
      );
    }
    bindingIds.add(binding.bindingId);
    validateBindingTermAndStrength(binding, path, issues);
    validateBindingTarget(binding.target, `${path}.target`, issues);
  });
}

function validateBindingTermAndStrength(
  binding: RallarOntologyBinding,
  path: string,
  issues: RallarOntologyIssue[],
): void {
  if (!isValidRallarOntologyTermId(binding.termId)) {
    issues.push(
      createRallarOntologyIssue(
        'invalid-term-iri',
        `${path}.termId`,
        'Binding term must be a literal governed term IRI.',
      ),
    );
  }
  if (!bindingStrengths.has(binding.strength)) {
    issues.push(
      createRallarOntologyIssue(
        'invalid-binding-strength',
        `${path}.strength`,
        'Binding strength must be contractual, owner, implementation, or example.',
      ),
    );
  }
}

function validateProfiles(
  bindingSet: RallarOntologyBindingModule,
  issues: RallarOntologyIssue[],
): void {
  const profileIds = new Set<string>();
  bindingSet.profiles.forEach((profile, profileIndex) => {
    const path = `bindingSet.profiles[${profileIndex}]`;
    addInvalidIdentity({
      invalid: !isValidRallarOntologyBindingProfileId(profile.profileId),
      path: `${path}.profileId`,
      message: 'Profile ID must be a literal governed binding-profile IRI.',
      issues,
    });
    if (profileIds.has(profile.profileId)) {
      issues.push(
        createRallarOntologyIssue(
          'duplicate-binding-profile-id',
          `${path}.profileId`,
          'Binding profile IDs must be unique.',
        ),
      );
    }
    profileIds.add(profile.profileId);
    if (!isValidRallarOntologyTermId(profile.termId)) {
      issues.push(
        createRallarOntologyIssue(
          'invalid-term-iri',
          `${path}.termId`,
          'Profile term must be a literal governed term IRI.',
        ),
      );
    }
  });
}

function validateBindingTarget(
  target: RallarOntologyBindingTarget,
  path: string,
  issues: RallarOntologyIssue[],
): void {
  switch (target.kind) {
    case 'typescript-export':
      validateTargetPath(target.modulePath, `${path}.modulePath`, issues);
      validateTargetName(target.exportName, `${path}.exportName`, issues);
      break;
    case 'wire-constant':
      validateTargetPath(target.modulePath, `${path}.modulePath`, issues);
      validateTargetName(target.exportName, `${path}.exportName`, issues);
      target.propertyPath?.forEach((segment, index) =>
        validatePropertySegment(segment, `${path}.propertyPath[${index}]`, issues),
      );
      break;
    case 'openapi-component':
      validateTargetPath(target.documentPath, `${path}.documentPath`, issues);
      validateTargetName(target.componentName, `${path}.componentName`, issues);
      break;
    case 'runtime-validator':
      validateTargetPath(target.modulePath, `${path}.modulePath`, issues);
      validateTargetName(target.exportName, `${path}.exportName`, issues);
      validateTargetName(target.validatorId, `${path}.validatorId`, issues);
      break;
    case 'normative-anchor':
      validateTargetPath(target.documentPath, `${path}.documentPath`, issues);
      validateTargetName(target.anchor, `${path}.anchor`, issues);
      break;
    case 'export-property':
      validateTargetPath(target.modulePath, `${path}.modulePath`, issues);
      validateTargetName(target.exportName, `${path}.exportName`, issues);
      validatePropertySegment(target.propertyName, `${path}.propertyName`, issues);
      break;
    case 'package-script':
      validateTargetPath(target.manifestPath, `${path}.manifestPath`, issues);
      validateTargetName(target.scriptName, `${path}.scriptName`, issues);
      break;
    case 'repository-owner':
      if (!isValidRallarOntologyOwnerId(target.ownerId)) {
        addTargetIssue(`${path}.ownerId`, 'Repository owner must be a governed owner IRI.', issues);
      }
      validateTargetPath(target.path, `${path}.path`, issues);
      break;
    case 'implementation-symbol':
      validateTargetPath(target.path, `${path}.path`, issues);
      validateTargetName(target.symbol, `${path}.symbol`, issues);
      break;
    case 'example':
      validateTargetPath(target.path, `${path}.path`, issues);
      break;
    default:
      addTargetIssue(`${path}.kind`, 'Binding target kind is not supported.', issues);
  }
}

function validateTargetPath(value: string, path: string, issues: RallarOntologyIssue[]): void {
  if (!isRepositoryRelativeOntologyTarget(value)) {
    addTargetIssue(path, 'Target path must be safe and repository-relative.', issues);
  }
}

function validateTargetName(value: string, path: string, issues: RallarOntologyIssue[]): void {
  if (value.trim().length === 0) {
    addTargetIssue(path, 'Target name must be non-empty.', issues);
  }
}

function validatePropertySegment(value: string, path: string, issues: RallarOntologyIssue[]): void {
  if (!isSafeOntologyPropertySegment(value)) {
    addTargetIssue(path, 'Property segment must be a safe non-empty identifier.', issues);
  }
}

function addInvalidIdentity(input: AddInvalidIdentityInput): void {
  if (input.invalid) {
    input.issues.push(createRallarOntologyIssue('invalid-ontology-iri', input.path, input.message));
  }
}

function addTargetIssue(path: string, message: string, issues: RallarOntologyIssue[]): void {
  issues.push(createRallarOntologyIssue('invalid-binding-target', path, message));
}
