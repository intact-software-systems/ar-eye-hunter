import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
  RALLAR_CRDT_APP_TOPIC_ID,
  RALLAR_CRDT_CATCH_UP_REQUEST_TYPE_ID,
  RALLAR_CRDT_CATCH_UP_RESPONSE_TYPE_ID,
  RALLAR_CRDT_ROOM_TOPIC_ID,
  RALLAR_CRDT_SYNC_REQUEST_TYPE_ID,
  RALLAR_CRDT_SYNC_RESPONSE_TYPE_ID,
  RALLAR_CRDT_UPDATE_TYPE_ID,
  RALLAR_CRDT_PROTOCOL_VERSION,
  evaluateRallarCrdtFeaturePolicy,
  type RallarCrdtCatchUpRequestEnvelope,
  type RallarCrdtCatchUpResponseEnvelope,
  type RallarCrdtAdminReadRepository,
  type RallarCrdtDocumentRef,
  type RallarCrdtDocumentTypePolicy,
  type RallarCrdtOperationKind,
  type RallarCrdtSyncRequestEnvelope,
  type RallarCrdtSyncResponseEnvelope,
  type RallarCrdtUpdateEnvelope,
  type RallarCrdtValidationIssue,
  type RallarCrdtValidationOptions,
  type RallarCrdtValidationResult,
  validateRallarCrdtDocumentRef,
  validateRallarCrdtSyncRequestEnvelope,
  validateRallarCrdtSyncResponseEnvelope,
  validateRallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import { newALEventRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import type {
  RallarServerWsFacade,
  RallarServerWsFanout,
  RallarServerWsHandler,
  RallarServerWsMessage,
  RallarServerWsMessageContext,
  RallarServerWsTopicDefinition,
} from '../rallar-facade/ws-topic-router.ts';
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
interface ValidateRallarCrdtServerLiveEnvelopeInput {
  readonly kind: RallarCrdtServerEnvelopeKind;
  readonly topicScope: RallarCrdtServerTopicScope;
  readonly value: unknown;
  readonly context: RallarCrdtServerLiveValidationContext;
  readonly options?: RallarCrdtServerTopicBridgeOptions;
}
export function installRallarCrdtWsTopics(
  ws: RallarCrdtServerWsTopicInstaller,
  options: RallarCrdtServerTopicBridgeOptions = {},
): RallarCrdtServerTopicBridge {
  const definitions = [
    createRallarCrdtTopicDefinition('update', 'room', options),
    createRallarCrdtTopicDefinition('sync-request', 'room', options),
    createRallarCrdtTopicDefinition('sync-response', 'room', options),
    createRallarCrdtTopicDefinition('catch-up-request', 'room', options),
    createRallarCrdtTopicDefinition('catch-up-response', 'room', options),
    createRallarCrdtTopicDefinition('update', 'app', options),
    createRallarCrdtTopicDefinition('sync-request', 'app', options),
    createRallarCrdtTopicDefinition('sync-response', 'app', options),
    createRallarCrdtTopicDefinition('catch-up-request', 'app', options),
    createRallarCrdtTopicDefinition('catch-up-response', 'app', options),
  ];
  definitions.forEach((definition) => ws.defineTopic(definition));

  const shouldInstallHandlers =
    options.onAcceptedEnvelope || options.logRepository || options.mutationIngress;
  const unsubscribes = shouldInstallHandlers
    ? definitions.map((definition) =>
        ws.on(
          {
            topicId: definition.topicId,
            typeId: definition.typeId,
          },
          createAcceptedEnvelopeHandler(options),
        ),
      )
    : [];

  return {
    topicIds: [RALLAR_CRDT_ROOM_TOPIC_ID, RALLAR_CRDT_APP_TOPIC_ID],
    definitions,
    unsubscribeHandlers: () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    },
  };
}

export function validateRallarCrdtServerLiveEnvelope(
  kind: RallarCrdtServerEnvelopeKind,
  topicScope: RallarCrdtServerTopicScope,
  value: unknown,
  context: RallarCrdtServerLiveValidationContext,
  options: RallarCrdtServerTopicBridgeOptions = {},
): RallarCrdtValidationResult {
  return validateRallarCrdtServerLiveEnvelopeInput({ kind, topicScope, value, context, options });
}

function validateRallarCrdtServerLiveEnvelopeInput(
  input: ValidateRallarCrdtServerLiveEnvelopeInput,
): RallarCrdtValidationResult {
  const { kind, topicScope, value, context, options = {} } = input;
  const validationOptions = toSharedValidationOptions(options);
  const base = validateEnvelopeByKind(kind, value, validationOptions);
  const issues = [...base.issues];

  if (kind === 'update' && !options.mutationIngress) {
    issues.push({
      path: '$',
      code: 'mutation-ingress-required',
      message: 'CRDT updates require durable mutation ingress.',
    });
  }

  if (base.valid) {
    const document = readEnvelopeDocument(value);
    if (!document) {
      issues.push({
        path: '$.document',
        code: 'missing-document-ref',
        message: 'CRDT live envelope must contain a document ref.',
      });
    } else {
      issues.push(...validateLiveDocumentScope({ document, topicScope, context, options }));
    }
  }

  issues.push(...collectKnownBinaryJsonShapeIssues(value));

  return {
    valid: issues.length === 0,
    issues,
  };
}

function createRallarCrdtTopicDefinition(
  kind: RallarCrdtServerEnvelopeKind,
  topicScope: RallarCrdtServerTopicScope,
  options: RallarCrdtServerTopicBridgeOptions,
): RallarServerWsTopicDefinition {
  const typeId = toTypeId(kind);
  const maxPayloadBytes =
    kind === 'update'
      ? (options.maxUpdateBytes ?? RALLAR_CRDT_SERVER_DEFAULT_MAX_UPDATE_BYTES)
      : (options.maxSyncBytes ?? RALLAR_CRDT_SERVER_DEFAULT_MAX_SYNC_BYTES);

  return {
    topicId: toTopicId(topicScope),
    typeId,
    scope: topicScope,
    maxPayloadBytes,
    fanout:
      kind === 'update' || (kind === 'catch-up-request' && options.logRepository)
        ? 'none'
        : (options.fanout ?? 'live-only'),
    validate: (value, context) =>
      validateRallarCrdtServerLiveEnvelope(
        kind,
        topicScope,
        value,
        {
          topicId: context.definition?.topicId ?? toTopicId(topicScope),
          typeId,
          roomId: context.roomId,
          roomRef: context.roomRef,
        },
        options,
      ).valid,
    authorize:
      options.authorizeDocument || options.policies?.length
        ? async (message, context) =>
            await authorizeAcceptedEnvelope({ kind, message, context, options })
        : undefined,
  };
}

function createAcceptedEnvelopeHandler(
  options: RallarCrdtServerTopicBridgeOptions,
): RallarServerWsHandler {
  return async (message, context) => {
    const kind = toEnvelopeKind(message.raw.payload.typeId);
    if (!kind) {
      return;
    }
    if (kind === 'update' && options.mutationIngress) {
      await options.mutationIngress.enqueueUpdate({
        kind,
        envelope: message.payload as RallarCrdtUpdateEnvelope,
        trusted: toTrustedMetadata(message, context),
        raw: message.raw,
      });
    } else if (kind === 'catch-up-request' && options.logRepository) {
      await respondToDurableCatchUpRequest(
        message as RallarServerWsMessage<RallarCrdtCatchUpRequestEnvelope>,
        context,
        options,
      );
    }

    await options.onAcceptedEnvelope?.({
      kind,
      envelope: message.payload as never,
      trusted: toTrustedMetadata(message, context),
      raw: message.raw,
    } as RallarCrdtServerAcceptedEnvelope);
  };
}

async function respondToDurableCatchUpRequest(
  message: RallarServerWsMessage<RallarCrdtCatchUpRequestEnvelope>,
  context: RallarServerWsMessageContext<unknown>,
  options: RallarCrdtServerTopicBridgeOptions,
): Promise<void> {
  const repository = options.logRepository;
  if (!repository) {
    return;
  }

  const page = await repository.listAfter({
    document: message.payload.document,
    afterSequence: message.payload.afterSequence,
    afterCursor: message.payload.afterCursor,
    limit: message.payload.maxUpdateCount,
  });
  const snapshot =
    message.payload.includeSnapshot === false
      ? undefined
      : await repository.readSnapshot(message.payload.document);
  const response: RallarCrdtCatchUpResponseEnvelope = {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    requestId: message.payload.requestId,
    document: message.payload.document,
    createdAtEpochMs: Date.now(),
    snapshot,
    page,
  };

  await context.proxy.toPeer(
    context.senderId,
    newALUntargetedMessage(
      context.service.name,
      newALEventRoute(
        message.raw.route.topicId,
        message.raw.route.contextId,
        message.payload.requestId,
      ),
      RALLAR_CRDT_CATCH_UP_RESPONSE_TYPE_ID,
      response,
    ),
    'live-only',
  );
}

interface AuthorizeAcceptedEnvelopeInput {
  readonly kind: RallarCrdtServerEnvelopeKind;
  readonly message: RallarServerWsMessage<unknown>;
  readonly context: RallarServerWsMessageContext<unknown>;
  readonly options: RallarCrdtServerTopicBridgeOptions;
}

async function authorizeAcceptedEnvelope(input: AuthorizeAcceptedEnvelopeInput): Promise<boolean> {
  const { kind, message, context, options } = input;
  const document = readEnvelopeDocument(message.payload);
  if (!document) {
    return false;
  }

  const policyDecision = evaluateRallarCrdtFeaturePolicy({
    document,
    operation:
      kind === 'update'
        ? 'ws-send'
        : kind === 'catch-up-request'
          ? 'durable-catch-up'
          : 'peer-catch-up',
    policies: options.policies,
  });
  if (!policyDecision.allowed) {
    return false;
  }

  return await Promise.resolve(
    options.authorizeDocument?.({
      kind,
      document,
      envelope: message.payload,
      trusted: toTrustedMetadata(message, context),
      raw: message.raw,
    }) ?? true,
  );
}

function validateEnvelopeByKind(
  kind: RallarCrdtServerEnvelopeKind,
  value: unknown,
  options: RallarCrdtValidationOptions,
): RallarCrdtValidationResult {
  switch (kind) {
    case 'update':
      return validateRallarCrdtUpdateEnvelope(value, '$', options);
    case 'sync-request':
      return validateRallarCrdtSyncRequestEnvelope(value, '$', options);
    case 'sync-response':
      return validateRallarCrdtSyncResponseEnvelope(value, '$', options);
    case 'catch-up-request':
      return validateRallarCrdtCatchUpRequestEnvelope(value, '$', options);
    case 'catch-up-response':
      return validateRallarCrdtCatchUpResponseEnvelope(value, '$', options);
  }
}

function validateRallarCrdtCatchUpRequestEnvelope(
  value: unknown,
  path: string,
  options: RallarCrdtValidationOptions,
): RallarCrdtValidationResult {
  const issues: RallarCrdtValidationIssue[] = [];
  if (!isRecord(value)) {
    return {
      valid: false,
      issues: [
        {
          path,
          code: 'invalid-catch-up-request',
          message: 'CRDT catch-up request must be an object.',
        },
      ],
    };
  }

  requireExactProtocolVersion(value.protocolVersion, path, issues);
  requireNonEmptyString(value.requestId, `${path}.requestId`, issues);
  requireNonEmptyString(value.replicaId, `${path}.replicaId`, issues);
  requireNonNegativeInteger(value.createdAtEpochMs, `${path}.createdAtEpochMs`, issues);
  if (value.afterSequence !== undefined) {
    requireNonNegativeInteger(value.afterSequence, `${path}.afterSequence`, issues);
  }
  if (value.afterCursor !== undefined) {
    requireNonEmptyString(value.afterCursor, `${path}.afterCursor`, issues);
  }
  if (value.maxUpdateCount !== undefined) {
    requireNonNegativeInteger(value.maxUpdateCount, `${path}.maxUpdateCount`, issues);
  }
  if (value.includeSnapshot !== undefined && typeof value.includeSnapshot !== 'boolean') {
    issues.push({
      path: `${path}.includeSnapshot`,
      code: 'invalid-include-snapshot',
      message: 'CRDT catch-up includeSnapshot must be boolean.',
    });
  }
  issues.push(...validateRallarCrdtDocumentRef(value.document, `${path}.document`, options).issues);

  return {
    valid: issues.length === 0,
    issues,
  };
}

function validateRallarCrdtCatchUpResponseEnvelope(
  value: unknown,
  path: string,
  options: RallarCrdtValidationOptions,
): RallarCrdtValidationResult {
  const issues: RallarCrdtValidationIssue[] = [];
  if (!isRecord(value)) {
    return {
      valid: false,
      issues: [
        {
          path,
          code: 'invalid-catch-up-response',
          message: 'CRDT catch-up response must be an object.',
        },
      ],
    };
  }

  requireExactProtocolVersion(value.protocolVersion, path, issues);
  requireNonEmptyString(value.requestId, `${path}.requestId`, issues);
  requireNonNegativeInteger(value.createdAtEpochMs, `${path}.createdAtEpochMs`, issues);
  if (!isRecord(value.page)) {
    issues.push({
      path: `${path}.page`,
      code: 'invalid-catch-up-page',
      message: 'CRDT catch-up response page must be an object.',
    });
  }
  issues.push(...validateRallarCrdtDocumentRef(value.document, `${path}.document`, options).issues);

  return {
    valid: issues.length === 0,
    issues,
  };
}

interface ValidateLiveDocumentScopeInput {
  readonly document: RallarCrdtDocumentRef;
  readonly topicScope: RallarCrdtServerTopicScope;
  readonly context: RallarCrdtServerLiveValidationContext;
  readonly options: RallarCrdtServerTopicBridgeOptions;
}

function validateLiveDocumentScope(
  input: ValidateLiveDocumentScopeInput,
): readonly RallarCrdtValidationIssue[] {
  const { document, topicScope, context, options } = input;
  const issues: RallarCrdtValidationIssue[] = [];

  if (topicScope === 'room') {
    if (document.scope !== 'room') {
      issues.push({
        path: '$.document.scope',
        code: 'unsupported-live-document-scope',
        message: 'room.crdt only supports room-scoped CRDT documents.',
      });
      return issues;
    }

    if (!context.roomRef) {
      issues.push({
        path: '$.document.roomRef',
        code: 'missing-message-room-ref',
        message: 'Room CRDT live messages must carry a scoped AL target groupRef.',
      });
      return issues;
    }

    if (!document.roomRef) {
      issues.push({
        path: '$.document.roomRef',
        code: 'missing-room-ref',
        message: 'Room-scoped CRDT documents require roomRef.',
      });
      return issues;
    }

    if (!sameGroupRef(document.roomRef, context.roomRef)) {
      issues.push({
        path: '$.document.roomRef',
        code: 'message-room-ref-mismatch',
        message: 'CRDT document roomRef must match the AL message target groupRef.',
      });
    }

    if (context.roomId !== undefined && context.roomId !== document.roomRef.groupId) {
      issues.push({
        path: '$.document.roomRef.groupId',
        code: 'message-room-id-mismatch',
        message: 'CRDT document room groupId must match the AL message room context.',
      });
    }

    return issues;
  }

  if (document.scope === 'app' && options.allowAppDocuments === true) {
    return issues;
  }

  if (
    document.scope === 'principal' &&
    options.allowPrincipalDocuments === true &&
    options.mutationIngress
  ) {
    return issues;
  }

  if (document.scope === 'principal') {
    issues.push({
      path: '$.document.scope',
      code: 'unsupported-live-document-scope',
      message: 'app.crdt principal live messages require durable AppInbox mutation ingress.',
    });
    return issues;
  }

  if (document.scope !== 'app' || options.allowAppDocuments !== true) {
    issues.push({
      path: '$.document.scope',
      code: 'unsupported-live-document-scope',
      message: 'app.crdt live messages only support explicitly enabled app-scoped documents.',
    });
  }

  return issues;
}

function toSharedValidationOptions(
  options: RallarCrdtServerTopicBridgeOptions,
): RallarCrdtValidationOptions {
  return {
    ...options.validation,
    ...(options.allowedDocumentTypes ? { allowedDocumentTypes: options.allowedDocumentTypes } : {}),
    ...(options.allowedSchemaVersions
      ? { allowedSchemaVersions: options.allowedSchemaVersions }
      : {}),
    ...(options.allowedOperationKinds
      ? { allowedOperationKinds: options.allowedOperationKinds }
      : {}),
    maxPayloadBytes: options.maxUpdateBytes ?? options.validation?.maxPayloadBytes,
  };
}

function collectKnownBinaryJsonShapeIssues(value: unknown): readonly RallarCrdtValidationIssue[] {
  const issues: RallarCrdtValidationIssue[] = [];
  collectKnownBinaryJsonShapeIssuesAt(value, '$', issues);
  return issues;
}

function collectKnownBinaryJsonShapeIssuesAt(
  value: unknown,
  path: string,
  issues: RallarCrdtValidationIssue[],
): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectKnownBinaryJsonShapeIssuesAt(entry, `${path}[${index}]`, issues),
    );
    return;
  }

  const record = value as Record<string, unknown>;
  if (
    record.type === 'Buffer' &&
    Array.isArray(record.data) &&
    record.data.every((entry) => Number.isInteger(entry))
  ) {
    issues.push({
      path,
      code: 'raw-binary-payload',
      message: 'CRDT live payloads must not include raw Buffer/Blob-like values.',
    });
    return;
  }

  Object.entries(record).forEach(([key, entry]) =>
    collectKnownBinaryJsonShapeIssuesAt(entry, `${path}.${key}`, issues),
  );
}

function toTypeId(kind: RallarCrdtServerEnvelopeKind): string {
  switch (kind) {
    case 'update':
      return RALLAR_CRDT_UPDATE_TYPE_ID;
    case 'sync-request':
      return RALLAR_CRDT_SYNC_REQUEST_TYPE_ID;
    case 'sync-response':
      return RALLAR_CRDT_SYNC_RESPONSE_TYPE_ID;
    case 'catch-up-request':
      return RALLAR_CRDT_CATCH_UP_REQUEST_TYPE_ID;
    case 'catch-up-response':
      return RALLAR_CRDT_CATCH_UP_RESPONSE_TYPE_ID;
  }
}

function toEnvelopeKind(typeId: string): RallarCrdtServerEnvelopeKind | undefined {
  switch (typeId) {
    case RALLAR_CRDT_UPDATE_TYPE_ID:
      return 'update';
    case RALLAR_CRDT_SYNC_REQUEST_TYPE_ID:
      return 'sync-request';
    case RALLAR_CRDT_SYNC_RESPONSE_TYPE_ID:
      return 'sync-response';
    case RALLAR_CRDT_CATCH_UP_REQUEST_TYPE_ID:
      return 'catch-up-request';
    case RALLAR_CRDT_CATCH_UP_RESPONSE_TYPE_ID:
      return 'catch-up-response';
    default:
      return undefined;
  }
}

function toTopicId(scope: RallarCrdtServerTopicScope): string {
  return scope === 'room' ? RALLAR_CRDT_ROOM_TOPIC_ID : RALLAR_CRDT_APP_TOPIC_ID;
}

function readEnvelopeDocument(value: unknown): RallarCrdtDocumentRef | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const document = Reflect.get(value, 'document');
  return document && typeof document === 'object' ? (document as RallarCrdtDocumentRef) : undefined;
}

function toTrustedMetadata(
  message: RallarServerWsMessage<unknown>,
  context: RallarServerWsMessageContext<unknown>,
): RallarCrdtServerTrustedMetadata {
  const envelope =
    message.payload && typeof message.payload === 'object' ? message.payload : undefined;
  const actorId = envelope ? Reflect.get(envelope, 'actorId') : undefined;
  const sessionId = envelope ? Reflect.get(envelope, 'sessionId') : undefined;

  return {
    senderId: context.senderId,
    sessionId: context.senderId,
    claimedActorId: typeof actorId === 'string' ? actorId : undefined,
    claimedSessionId: typeof sessionId === 'string' ? sessionId : message.raw.id.sessionId,
    receivedAtEpochMs: message.receivedAtEpochMs,
    topicId: message.raw.route.topicId,
    typeId: message.raw.payload.typeId,
    roomId: context.roomId,
    roomRef: context.roomRef,
  };
}

function sameGroupRef(left: GroupRef, right: GroupRef): boolean {
  return (
    left.applicationId === right.applicationId &&
    left.workspaceId === right.workspaceId &&
    left.groupId === right.groupId
  );
}

function requireExactProtocolVersion(
  value: unknown,
  path: string,
  issues: RallarCrdtValidationIssue[],
): void {
  if (value !== RALLAR_CRDT_PROTOCOL_VERSION) {
    issues.push({
      path: `${path}.protocolVersion`,
      code: 'unknown-protocol-version',
      message: `Expected ${RALLAR_CRDT_PROTOCOL_VERSION}.`,
    });
  }
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  issues: RallarCrdtValidationIssue[],
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push({
      path,
      code: 'invalid-non-empty-string',
      message: 'Expected a non-empty string.',
    });
  }
}

function requireNonNegativeInteger(
  value: unknown,
  path: string,
  issues: RallarCrdtValidationIssue[],
): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    issues.push({
      path,
      code: 'invalid-non-negative-integer',
      message: 'Expected a non-negative integer.',
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
