import {
  RALLAR_RELATION_IDS,
  type RallarOntologyBindingModule,
  type RallarOntologyBindingProfileBase,
  type RallarOntologyVocabularyModule,
} from '@shared/ontology/rallar-ontology-contracts.ts';
import type { RallarDomainOntologyTerm } from '@shared/ontology/rallar-domain-ontology-term.ts';
import type {
  RallarMessageOntologyBindingProfile,
  RallarMessageOntologyTerm,
  RallarRtcLaneOntologyTerm,
} from '@shared/ontology/rallar-realtime-ontology-contracts.ts';

export const ONTOLOGY_BASE =
  'https://github.com/intact-software-systems/ar-eye-hunter/ontology' as const;
export const TEST_ONTOLOGY_ID = `${ONTOLOGY_BASE}/extension/acme/core` as const;
export const TEST_ONTOLOGY_VERSION_IRI = `${TEST_ONTOLOGY_ID}/version/0.1.0` as const;
export const TEST_OWNER_ID = `${ONTOLOGY_BASE}/owner/acme` as const;
export const TEST_PARENT_TERM_ID = `${ONTOLOGY_BASE}/term/acme.parent` as const;
export const TEST_CHILD_TERM_ID = `${ONTOLOGY_BASE}/term/acme.child` as const;
export const TEST_BINDING_SET_ID = `${ONTOLOGY_BASE}/binding-set/acme.core` as const;
export const TEST_BINDING_SET_VERSION_IRI = `${TEST_BINDING_SET_ID}/version/0.1.0` as const;
export const TEST_BINDING_ID = `${ONTOLOGY_BASE}/binding/acme.core.export` as const;
export const TEST_PROFILE_ID = `${ONTOLOGY_BASE}/binding-profile/acme.core.profile` as const;

export function createRallarOntologyVocabularyFixture(
  overrides: Partial<RallarOntologyVocabularyModule> = {},
): RallarOntologyVocabularyModule {
  return {
    ontologyId: TEST_ONTOLOGY_ID,
    ownerId: TEST_OWNER_ID,
    version: '0.1.0',
    versionIri: TEST_ONTOLOGY_VERSION_IRI,
    maturity: 'experimental',
    compatibleWith: [],
    requiredVocabularyVersionIris: [],
    competencyQuestionIds: ['CQ-acme-core'],
    terms: [
      {
        termId: TEST_PARENT_TERM_ID,
        kind: 'concept',
        label: 'Parent',
        definition: 'The parent concept.',
        status: 'draft',
        references: [],
      },
      {
        termId: TEST_CHILD_TERM_ID,
        kind: 'concept',
        label: 'Child',
        definition: 'The child concept.',
        status: 'draft',
        references: [
          {
            relationId: RALLAR_RELATION_IDS.scopedBy,
            targetTermId: TEST_PARENT_TERM_ID,
          },
        ],
      },
    ],
    ...overrides,
  };
}

export function createRallarOntologyBindingModuleFixture(
  overrides: Partial<RallarOntologyBindingModule> = {},
): RallarOntologyBindingModule {
  return {
    bindingSetId: TEST_BINDING_SET_ID,
    ontologyId: TEST_ONTOLOGY_ID,
    vocabularyVersionIri: TEST_ONTOLOGY_VERSION_IRI,
    ownerId: TEST_OWNER_ID,
    version: '0.1.0',
    versionIri: TEST_BINDING_SET_VERSION_IRI,
    maturity: 'experimental',
    compatibleWith: [],
    bindings: [
      {
        bindingId: TEST_BINDING_ID,
        termId: TEST_PARENT_TERM_ID,
        role: 'authoritative-contract',
        strength: 'contractual',
        target: {
          kind: 'typescript-export',
          modulePath: 'packages/shared/example.ts',
          exportName: 'AcmeParent',
        },
      },
    ],
    profiles: [
      {
        profileId: TEST_PROFILE_ID,
        termId: TEST_PARENT_TERM_ID,
        kind: 'generic',
      },
    ],
    ...overrides,
  };
}

export interface RallarOntologyCustomOrderedProfile extends RallarOntologyBindingProfileBase {
  readonly kind: 'custom-ordered';
  readonly metadata: Readonly<{ orderedSteps: readonly string[] }>;
}

export interface RallarOntologySpecializedCopyFixture {
  readonly vocabulary: RallarOntologyVocabularyModule;
  readonly bindingSet: RallarOntologyBindingModule;
  readonly domainTerm: RallarDomainOntologyTerm;
  readonly messageTerm: RallarMessageOntologyTerm;
  readonly laneTerm: RallarRtcLaneOntologyTerm;
  readonly messageProfile: RallarMessageOntologyBindingProfile;
  readonly customProfile: RallarOntologyCustomOrderedProfile;
}

export function createRallarOntologyCustomOrderedProfileFixture(
  orderedSteps: readonly string[] = ['zAuthoredFirst', 'aAuthoredSecond'],
): RallarOntologyCustomOrderedProfile {
  return {
    profileId: `${ONTOLOGY_BASE}/binding-profile/acme.custom-ordered`,
    termId: TEST_PARENT_TERM_ID,
    kind: 'custom-ordered',
    metadata: { orderedSteps },
  };
}

export function createRallarOntologySpecializedCopyFixture(): RallarOntologySpecializedCopyFixture {
  const terms = createRallarOntologyVocabularyFixture().terms;
  const domainTerm: RallarDomainOntologyTerm = {
    ...terms[0],
    kind: 'domain',
    domainKind: 'identity',
    authority: 'authoritative',
    identityFields: ['zAuthoredFirst', 'aAuthoredSecond'],
  };
  const messageTerm: RallarMessageOntologyTerm = {
    ...terms[1],
    kind: 'message-type',
    wireTypeId: 'acme.message.v1',
    routes: [
      {
        routeId: `${ONTOLOGY_BASE}/route/acme.message`,
        topicId: 'acme.message',
        scope: 'room',
        transports: ['al-ws', 'al-rtc'],
        targetModes: ['broadcast', 'unicast'],
        requestedReliability: 'best-effort',
        acknowledgement: 'none',
        ordering: 'none',
        deduplication: 'none',
        supersedence: 'none',
        qosOwnership: 'sender',
        authorization: 'required',
      },
    ],
    senderKinds: ['server-node', 'client-session'],
    validation: {
      kind: 'runtime-payload',
      schemaVersion: { kind: 'payload-field', fieldPath: '$.schemaVersion' },
    },
    correlation: 'message-id',
  };
  const laneTerm: RallarRtcLaneOntologyTerm = {
    ...terms[0],
    termId: `${ONTOLOGY_BASE}/term/acme.lane`,
    kind: 'rtc-lane',
    laneId: 'acme-lane',
    envelope: 'none',
    payloadKinds: ['binary', 'json'],
    roomScopeCarrier: 'payload-room-ref-or-unique-lane',
  };
  const messageProfile: RallarMessageOntologyBindingProfile = {
    profileId: `${ONTOLOGY_BASE}/binding-profile/acme.message`,
    termId: messageTerm.termId,
    kind: 'message-bindings',
    wireTypeBindingId: `${ONTOLOGY_BASE}/binding/acme.wire-type`,
    routeBindings: [
      {
        routeId: messageTerm.routes[0].routeId,
        topicBindingId: `${ONTOLOGY_BASE}/binding/acme.topic`,
        authorizationBindings: [
          {
            transport: 'al-ws',
            ownerBindingIds: [
              `${ONTOLOGY_BASE}/binding/acme.owner-z`,
              `${ONTOLOGY_BASE}/binding/acme.owner-a`,
            ],
          },
        ],
      },
    ],
    validation: {
      kind: 'unvalidated',
      boundaryBindingId: `${ONTOLOGY_BASE}/binding/acme.boundary`,
      gapOwnerBindingId: `${ONTOLOGY_BASE}/binding/acme.gap-owner`,
    },
  };
  const customProfile = createRallarOntologyCustomOrderedProfileFixture();
  const vocabulary = createRallarOntologyVocabularyFixture({
    terms: [domainTerm, messageTerm, laneTerm],
  });
  const bindingSet = createRallarOntologyBindingModuleFixture({
    bindings: [
      {
        ...createRallarOntologyBindingModuleFixture().bindings[0],
        target: {
          kind: 'wire-constant',
          modulePath: 'packages/shared/example.ts',
          exportName: 'EXAMPLE',
          propertyPath: ['zAuthoredFirst', 'aAuthoredSecond'],
        },
      },
    ],
    profiles: [messageProfile, customProfile],
  });
  return {
    vocabulary,
    bindingSet,
    domainTerm,
    messageTerm,
    laneTerm,
    messageProfile,
    customProfile,
  };
}
