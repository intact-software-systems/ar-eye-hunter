import type {
  RallarOntologyBinding,
  RallarOntologyBindingModule,
  RallarOntologyBindingProfileBase,
  RallarOntologyTermBase,
  RallarOntologyTermId,
  RallarOntologyVocabularyModule,
} from './rallar-ontology-contracts.ts';
import type { RallarDomainOntologyTerm } from './rallar-domain-ontology-term.ts';
import { compareRallarOntologyText } from './rallar-ontology-identity-validation.ts';
import type {
  CreateRallarOntologyCatalogInput,
  RallarOntologyCatalog,
} from './rallar-ontology-registry-contracts.ts';
import type {
  RallarMessageOntologyTerm,
  RallarPayloadValidationSemantics,
  RallarRtcLaneOntologyTerm,
} from './rallar-realtime-ontology-contracts.ts';
import { validateRallarOntologyCatalog } from './validate-rallar-ontology-catalog.ts';

export function createRallarOntologyCatalog(
  input: CreateRallarOntologyCatalogInput,
): RallarOntologyCatalog {
  const issues = validateRallarOntologyCatalog(input);
  if (issues.length > 0) {
    const details = issues
      .map((issue) => `${issue.path} [${issue.code}]: ${issue.message}`)
      .join('\n');
    throw new TypeError(`Invalid Rallar ontology catalog:\n${details}`);
  }

  const vocabularies = [...input.vocabularies]
    .map(copyVocabulary)
    .sort((left, right) => compareRallarOntologyText(left.ontologyId, right.ontologyId));
  const bindingSets = [...input.bindingSets]
    .map(copyBindingModule)
    .sort((left, right) => compareRallarOntologyText(left.bindingSetId, right.bindingSetId));
  const terms = vocabularies
    .flatMap((vocabulary) => vocabulary.terms)
    .sort((left, right) => compareRallarOntologyText(left.termId, right.termId));
  const bindings = bindingSets
    .flatMap((bindingSet) => bindingSet.bindings)
    .sort((left, right) => compareRallarOntologyText(left.bindingId, right.bindingId));
  const bindingProfiles = bindingSets
    .flatMap((bindingSet) => bindingSet.profiles)
    .sort((left, right) => compareRallarOntologyText(left.profileId, right.profileId));

  return { vocabularies, bindingSets, terms, bindings, bindingProfiles };
}

export function getRallarOntologyTerm(
  catalog: RallarOntologyCatalog,
  termId: RallarOntologyTermId,
): RallarOntologyTermBase | undefined {
  return catalog.terms.find((term) => term.termId === termId);
}

export function getRallarOntologyBindings(
  catalog: RallarOntologyCatalog,
  termId: RallarOntologyTermId,
): readonly RallarOntologyBinding[] {
  return catalog.bindings.filter((binding) => binding.termId === termId);
}

export function getRallarOntologyBindingProfiles(
  catalog: RallarOntologyCatalog,
  termId: RallarOntologyTermId,
): readonly RallarOntologyBindingProfileBase[] {
  return catalog.bindingProfiles.filter((profile) => profile.termId === termId);
}

function copyVocabulary(
  vocabulary: RallarOntologyVocabularyModule,
): RallarOntologyVocabularyModule {
  return {
    ...vocabulary,
    compatibleWith: [...vocabulary.compatibleWith].sort(compareRallarOntologyText),
    requiredVocabularyVersionIris: [...vocabulary.requiredVocabularyVersionIris].sort(
      compareRallarOntologyText,
    ),
    competencyQuestionIds: [...vocabulary.competencyQuestionIds].sort(compareRallarOntologyText),
    terms: [...vocabulary.terms]
      .map(copyTerm)
      .sort((left, right) => compareRallarOntologyText(left.termId, right.termId)),
  };
}

function copyTerm(term: RallarOntologyTermBase): RallarOntologyTermBase {
  const references = [...term.references]
    .map((reference) => ({ ...reference }))
    .sort(
      (left, right) =>
        compareRallarOntologyText(left.relationId, right.relationId) ||
        compareRallarOntologyText(left.targetTermId, right.targetTermId),
    );
  if (isDomainTerm(term)) {
    const copy: RallarDomainOntologyTerm = {
      ...term,
      references,
      identityFields: [...term.identityFields],
    };
    return copy;
  }
  if (isMessageTerm(term)) {
    const copy: RallarMessageOntologyTerm = {
      ...term,
      references,
      routes: term.routes.map((route) => ({
        ...route,
        transports: [...route.transports],
        targetModes: [...route.targetModes],
      })),
      senderKinds: [...term.senderKinds],
      validation: copyPayloadValidation(term.validation),
    };
    return copy;
  }
  if (isRtcLaneTerm(term)) {
    const copy: RallarRtcLaneOntologyTerm = {
      ...term,
      references,
      payloadKinds: [...term.payloadKinds],
    };
    return copy;
  }
  return { ...term, references };
}

function copyBindingModule(bindingSet: RallarOntologyBindingModule): RallarOntologyBindingModule {
  return {
    ...bindingSet,
    compatibleWith: [...bindingSet.compatibleWith].sort(compareRallarOntologyText),
    bindings: [...bindingSet.bindings]
      .map(copyBinding)
      .sort((left, right) => compareRallarOntologyText(left.bindingId, right.bindingId)),
    profiles: [...bindingSet.profiles]
      .map(copyBindingProfile)
      .sort((left, right) => compareRallarOntologyText(left.profileId, right.profileId)),
  };
}

function copyBindingProfile(
  profile: RallarOntologyBindingProfileBase,
): RallarOntologyBindingProfileBase {
  return structuredClone(profile);
}

function copyPayloadValidation(
  validation: RallarPayloadValidationSemantics,
): RallarPayloadValidationSemantics {
  if (validation.kind !== 'runtime-payload') {
    return { ...validation };
  }
  return { ...validation, schemaVersion: { ...validation.schemaVersion } };
}

function isDomainTerm(term: RallarOntologyTermBase): term is RallarDomainOntologyTerm {
  return term.kind === 'domain';
}

function isMessageTerm(term: RallarOntologyTermBase): term is RallarMessageOntologyTerm {
  return term.kind === 'message-type';
}

function isRtcLaneTerm(term: RallarOntologyTermBase): term is RallarRtcLaneOntologyTerm {
  return term.kind === 'rtc-lane';
}

function copyBinding(binding: RallarOntologyBinding): RallarOntologyBinding {
  if (binding.target.kind === 'wire-constant') {
    return {
      ...binding,
      target: {
        ...binding.target,
        propertyPath:
          binding.target.propertyPath === undefined ? undefined : [...binding.target.propertyPath],
      },
    };
  }
  return { ...binding, target: { ...binding.target } };
}
