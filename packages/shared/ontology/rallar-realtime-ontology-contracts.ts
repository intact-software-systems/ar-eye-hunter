import type {
  RallarOntologyBindingId,
  RallarOntologyBindingModule,
  RallarOntologyBindingProfileBase,
  RallarOntologyTermBase,
} from './rallar-ontology-contracts.ts';

export type RallarMessageTransportKind = 'al-rtc' | 'al-ws';
export type RallarMessageTargetMode = 'unicast' | 'multicast' | 'broadcast';
export type RallarMessageRouteId =
  `https://github.com/intact-software-systems/ar-eye-hunter/ontology/route/${string}`;
export type RallarSenderKind = 'client-session' | 'peer-session' | 'server-node' | 'system';

export interface RallarMessageRouteSemantics {
  readonly routeId: RallarMessageRouteId;
  readonly topicId: string;
  readonly scope: 'room' | 'app' | 'world' | 'all' | 'system';
  readonly transports: readonly RallarMessageTransportKind[];
  readonly targetModes: readonly RallarMessageTargetMode[];
  readonly requestedReliability: 'best-effort' | 'at-least-once';
  readonly acknowledgement: 'none' | 'receiver' | 'all-logical-recipients' | 'group-leader';
  readonly ordering: 'none' | 'al-policy' | 'al-policy-and-domain';
  readonly deduplication: 'none' | 'al-message-id' | 'al-semantic-key' | 'domain-owned';
  readonly supersedence: 'none' | 'al-latest-wins' | 'domain-owned';
  readonly qosOwnership: 'sender' | 'receiver' | 'shared' | 'domain-owned';
  readonly authorization: 'required' | 'not-applicable';
}

export type RallarPayloadSchemaVersionSemantics =
  | Readonly<{ kind: 'wire-type-id' }>
  | Readonly<{ kind: 'payload-field'; fieldPath: string }>
  | Readonly<{ kind: 'external-registry'; registryId: string }>;

export type RallarPayloadValidationSemantics =
  | Readonly<{ kind: 'runtime-payload'; schemaVersion: RallarPayloadSchemaVersionSemantics }>
  | Readonly<{ kind: 'envelope-only'; reason: string }>
  | Readonly<{
      kind: 'unvalidated';
      mechanism: 'generic-assertion' | 'unknown-payload';
      reason: string;
    }>;

export interface RallarMessageOntologyTerm extends RallarOntologyTermBase {
  readonly kind: 'message-type';
  readonly wireTypeId: string;
  readonly routes: readonly RallarMessageRouteSemantics[];
  readonly senderKinds: readonly RallarSenderKind[];
  readonly validation: RallarPayloadValidationSemantics;
  readonly correlation: 'message-id' | 'actions-correlation' | 'domain-owned';
}

export interface RallarRtcLaneOntologyTerm extends RallarOntologyTermBase {
  readonly kind: 'rtc-lane';
  readonly laneId: string;
  readonly envelope: 'none';
  readonly payloadKinds: readonly ('json' | 'binary')[];
  readonly roomScopeCarrier: 'payload-room-ref-or-unique-lane';
}

export type RallarPayloadValidationBinding =
  | Readonly<{
      kind: 'runtime-payload';
      schemaBindingId: RallarOntologyBindingId;
      schemaVersionContractBindingId: RallarOntologyBindingId;
      validatorBindingId: RallarOntologyBindingId;
    }>
  | Readonly<{
      kind: 'envelope-only';
      envelopeValidatorBindingId: RallarOntologyBindingId;
      payloadGapOwnerBindingId: RallarOntologyBindingId;
    }>
  | Readonly<{
      kind: 'unvalidated';
      boundaryBindingId: RallarOntologyBindingId;
      gapOwnerBindingId: RallarOntologyBindingId;
    }>;

export interface RallarMessageOntologyBindingProfile extends RallarOntologyBindingProfileBase {
  readonly kind: 'message-bindings';
  readonly wireTypeBindingId: RallarOntologyBindingId;
  readonly routeBindings: readonly Readonly<{
    routeId: RallarMessageRouteId;
    topicBindingId: RallarOntologyBindingId;
    authorizationBindings: readonly Readonly<{
      transport: RallarMessageTransportKind;
      ownerBindingIds: readonly RallarOntologyBindingId[];
    }>[];
  }>[];
  readonly validation: RallarPayloadValidationBinding;
}

export interface RallarRtcLaneOntologyBindingProfile extends RallarOntologyBindingProfileBase {
  readonly kind: 'rtc-lane-bindings';
  readonly laneConfigBindingId: RallarOntologyBindingId;
}

export type RallarRealtimeOntologyBindingModule = RallarOntologyBindingModule<
  RallarMessageOntologyBindingProfile | RallarRtcLaneOntologyBindingProfile
>;
