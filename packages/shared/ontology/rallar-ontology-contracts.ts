export type RallarOntologyIri =
  `https://github.com/intact-software-systems/ar-eye-hunter/ontology/${string}`;
export type RallarOntologyId = RallarOntologyIri;
export type RallarOntologyVersionIri = `${RallarOntologyId}/version/${number}.${number}.${number}`;
export type RallarOntologyTermId =
  `https://github.com/intact-software-systems/ar-eye-hunter/ontology/term/${string}`;
export type RallarOntologyOwnerId =
  `https://github.com/intact-software-systems/ar-eye-hunter/ontology/owner/${string}`;
export type RallarOntologyRelationId =
  | `https://github.com/intact-software-systems/ar-eye-hunter/ontology/relation/${string}`
  | 'http://www.w3.org/2004/02/skos/core#broader'
  | 'http://www.w3.org/2004/02/skos/core#narrower'
  | 'http://www.w3.org/2004/02/skos/core#related';
export type RallarOntologyVersion = `${number}.${number}.${number}`;
export type RallarOntologyCompetencyQuestionId = `CQ-${string}`;

export const RALLAR_RELATION_IDS = {
  scopedBy: 'https://github.com/intact-software-systems/ar-eye-hunter/ontology/relation/scoped-by',
  identifies:
    'https://github.com/intact-software-systems/ar-eye-hunter/ontology/relation/identifies',
  projects: 'https://github.com/intact-software-systems/ar-eye-hunter/ontology/relation/projects',
  identifiedBy:
    'https://github.com/intact-software-systems/ar-eye-hunter/ontology/relation/identified-by',
  sessionOf:
    'https://github.com/intact-software-systems/ar-eye-hunter/ontology/relation/session-of',
  runsOn: 'https://github.com/intact-software-systems/ar-eye-hunter/ontology/relation/runs-on',
  mayCarryScope:
    'https://github.com/intact-software-systems/ar-eye-hunter/ontology/relation/may-carry-scope',
  usesGroupRef:
    'https://github.com/intact-software-systems/ar-eye-hunter/ontology/relation/uses-group-ref',
} as const satisfies Record<string, RallarOntologyRelationId>;

export interface RallarOntologyReference {
  readonly relationId: RallarOntologyRelationId;
  readonly targetTermId: RallarOntologyTermId;
}

export interface RallarOntologyTermBase {
  readonly termId: RallarOntologyTermId;
  readonly kind: string;
  readonly label: string;
  readonly definition: string;
  readonly status: 'draft' | 'active' | 'deprecated';
  readonly references: readonly RallarOntologyReference[];
  readonly supersededBy?: RallarOntologyTermId;
  readonly removalCondition?: string;
}

export interface RallarOntologyVocabularyModule<
  TTerm extends RallarOntologyTermBase = RallarOntologyTermBase,
> {
  readonly ontologyId: RallarOntologyId;
  readonly ownerId: RallarOntologyOwnerId;
  readonly version: RallarOntologyVersion;
  readonly versionIri: RallarOntologyVersionIri;
  readonly maturity: 'experimental' | 'stable';
  readonly compatibleWith: readonly RallarOntologyVersionIri[];
  readonly requiredVocabularyVersionIris: readonly RallarOntologyVersionIri[];
  readonly competencyQuestionIds: readonly RallarOntologyCompetencyQuestionId[];
  readonly terms: readonly TTerm[];
}

export type RallarOntologyBindingId =
  `https://github.com/intact-software-systems/ar-eye-hunter/ontology/binding/${string}`;
export type RallarOntologyBindingSetId =
  `https://github.com/intact-software-systems/ar-eye-hunter/ontology/binding-set/${string}`;
export type RallarOntologyBindingProfileId =
  `https://github.com/intact-software-systems/ar-eye-hunter/ontology/binding-profile/${string}`;
export type RallarOntologyBindingStrength = 'contractual' | 'owner' | 'implementation' | 'example';

export type RallarOntologyBindingTarget =
  | Readonly<{ kind: 'typescript-export'; modulePath: string; exportName: string }>
  | Readonly<{
      kind: 'wire-constant';
      modulePath: string;
      exportName: string;
      propertyPath?: readonly string[];
    }>
  | Readonly<{ kind: 'openapi-component'; documentPath: string; componentName: string }>
  | Readonly<{
      kind: 'runtime-validator';
      modulePath: string;
      exportName: string;
      validatorId: string;
    }>
  | Readonly<{ kind: 'normative-anchor'; documentPath: string; anchor: string }>
  | Readonly<{
      kind: 'export-property';
      modulePath: string;
      exportName: string;
      propertyName: string;
    }>
  | Readonly<{ kind: 'package-script'; manifestPath: string; scriptName: string }>
  | Readonly<{ kind: 'repository-owner'; ownerId: RallarOntologyOwnerId; path: string }>
  | Readonly<{ kind: 'implementation-symbol'; path: string; symbol: string }>
  | Readonly<{ kind: 'example'; path: string }>;

export interface RallarOntologyBinding {
  readonly bindingId: RallarOntologyBindingId;
  readonly termId: RallarOntologyTermId;
  readonly role:
    | 'authoritative-contract'
    | 'projection'
    | 'wire-identity'
    | 'schema'
    | 'runtime-validation'
    | 'authorization-owner'
    | 'identifier'
    | 'normative-standard'
    | 'enforcement-owner'
    | 'enforcement-gate'
    | 'review-evidence'
    | 'exception-policy'
    | 'implementation'
    | 'example';
  readonly strength: RallarOntologyBindingStrength;
  readonly target: RallarOntologyBindingTarget;
}

export interface RallarOntologyBindingProfileBase {
  readonly profileId: RallarOntologyBindingProfileId;
  readonly termId: RallarOntologyTermId;
  readonly kind: string;
}

export interface RallarOntologyBindingModule<
  TProfile extends RallarOntologyBindingProfileBase = RallarOntologyBindingProfileBase,
> {
  readonly bindingSetId: RallarOntologyBindingSetId;
  readonly ontologyId: RallarOntologyId;
  readonly vocabularyVersionIri: RallarOntologyVersionIri;
  readonly ownerId: RallarOntologyOwnerId;
  readonly version: RallarOntologyVersion;
  readonly versionIri: RallarOntologyVersionIri;
  readonly maturity: 'experimental' | 'stable';
  readonly compatibleWith: readonly RallarOntologyVersionIri[];
  readonly bindings: readonly RallarOntologyBinding[];
  readonly profiles: readonly TProfile[];
}
