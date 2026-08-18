import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
  RallarCrdtAdminReadRepository,
  RallarCrdtCatchUpRequestEnvelope,
  RallarCrdtCatchUpResponseEnvelope,
  RallarCrdtDocumentRef,
  RallarCrdtDocumentTypePolicy,
  RallarCrdtOperationKind,
  RallarCrdtSyncRequestEnvelope,
  RallarCrdtSyncResponseEnvelope,
  RallarCrdtUpdateEnvelope,
  RallarCrdtValidationOptions,
} from '@shared/crdt/mod.ts';

import type {
  RallarServerWsFacade,
  RallarServerWsFanout,
  RallarServerWsTopicDefinition,
} from '../../../rallar-facade/ws-topic-router.ts';

export const RALLAR_CRDT_SERVER_DEFAULT_MAX_UPDATE_BYTES = 16 * 1024;
export const RALLAR_CRDT_SERVER_DEFAULT_MAX_SYNC_BYTES = 64 * 1024;

export type RallarCrdtServerEnvelopeKind =
  'update' | 'sync-request' | 'sync-response' | 'catch-up-request' | 'catch-up-response';

export type RallarCrdtServerTopicScope = 'room' | 'app';

export interface RallarCrdtServerTrustedMetadata {
  readonly senderId: string;
  readonly sessionId: string;
  readonly claimedActorId?: string;
  readonly claimedSessionId?: string;
  readonly receivedAtEpochMs: number;
  readonly topicId: string;
  readonly typeId: string;
  readonly roomId?: string;
  readonly roomRef?: GroupRef;
}

export type RallarCrdtServerAcceptedEnvelope =
  | Readonly<{
      kind: 'update';
      envelope: RallarCrdtUpdateEnvelope;
      trusted: RallarCrdtServerTrustedMetadata;
      raw: ALMessage;
    }>
  | Readonly<{
      kind: 'sync-request';
      envelope: RallarCrdtSyncRequestEnvelope;
      trusted: RallarCrdtServerTrustedMetadata;
      raw: ALMessage;
    }>
  | Readonly<{
      kind: 'sync-response';
      envelope: RallarCrdtSyncResponseEnvelope;
      trusted: RallarCrdtServerTrustedMetadata;
      raw: ALMessage;
    }>
  | Readonly<{
      kind: 'catch-up-request';
      envelope: RallarCrdtCatchUpRequestEnvelope;
      trusted: RallarCrdtServerTrustedMetadata;
      raw: ALMessage;
    }>
  | Readonly<{
      kind: 'catch-up-response';
      envelope: RallarCrdtCatchUpResponseEnvelope;
      trusted: RallarCrdtServerTrustedMetadata;
      raw: ALMessage;
    }>;

export interface RallarCrdtServerMutationIngress {
  readonly enqueueUpdate: (
    accepted: Extract<RallarCrdtServerAcceptedEnvelope, { kind: 'update' }>,
  ) => Promise<void>;
}

export interface RallarCrdtServerDocumentAuthorizationInput {
  readonly kind: RallarCrdtServerEnvelopeKind;
  readonly document: RallarCrdtDocumentRef;
  readonly envelope: unknown;
  readonly trusted: RallarCrdtServerTrustedMetadata;
  readonly raw: ALMessage;
}

export interface RallarCrdtServerTopicBridgeOptions {
  readonly allowedDocumentTypes?: readonly string[];
  readonly allowedSchemaVersions?: readonly number[];
  readonly allowedOperationKinds?: readonly RallarCrdtOperationKind[];
  readonly maxUpdateBytes?: number;
  readonly maxSyncBytes?: number;
  readonly validation?: RallarCrdtValidationOptions;
  readonly fanout?: RallarServerWsFanout;
  readonly allowAppDocuments?: boolean;
  readonly allowPrincipalDocuments?: boolean;
  readonly logRepository?: Pick<RallarCrdtAdminReadRepository, 'listAfter' | 'readSnapshot'>;
  readonly mutationIngress?: RallarCrdtServerMutationIngress;
  readonly policies?: readonly RallarCrdtDocumentTypePolicy[];
  readonly resolvePrincipalSessionIds?: (
    input: RallarCrdtServerPrincipalFanoutInput,
  ) => readonly string[] | Promise<readonly string[]>;
  readonly authorizeDocument?: (
    input: RallarCrdtServerDocumentAuthorizationInput,
  ) => boolean | Promise<boolean>;
  readonly onAcceptedEnvelope?: (
    accepted: RallarCrdtServerAcceptedEnvelope,
  ) => void | Promise<void>;
}

export interface RallarCrdtServerPrincipalFanoutInput {
  readonly document: RallarCrdtDocumentRef;
  readonly update: RallarCrdtUpdateEnvelope;
  readonly trusted: RallarCrdtServerTrustedMetadata;
  readonly raw: ALMessage;
}

export interface RallarCrdtServerTopicBridge {
  readonly topicIds: readonly string[];
  readonly definitions: readonly RallarServerWsTopicDefinition[];
  readonly unsubscribeHandlers: () => void;
}

export type RallarCrdtServerWsTopicInstaller = Pick<RallarServerWsFacade, 'defineTopic' | 'on'>;

export interface RallarCrdtServerLiveValidationContext {
  readonly topicId: string;
  readonly typeId: string;
  readonly roomId?: string;
  readonly roomRef?: GroupRef;
}
