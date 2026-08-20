import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALEventRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import {
  RALLAR_CRDT_APP_TOPIC_ID,
  RALLAR_CRDT_CATCH_UP_REQUEST_TYPE_ID,
  RALLAR_CRDT_CATCH_UP_RESPONSE_TYPE_ID,
  RALLAR_CRDT_PROTOCOL_VERSION,
  RALLAR_CRDT_ROOM_TOPIC_ID,
  RALLAR_CRDT_SYNC_REQUEST_TYPE_ID,
  RALLAR_CRDT_SYNC_RESPONSE_TYPE_ID,
  RALLAR_CRDT_UPDATE_TYPE_ID,
  evaluateRallarCrdtFeaturePolicy,
  type RallarCrdtCatchUpRequestEnvelope,
  type RallarCrdtCatchUpResponseEnvelope,
  type RallarCrdtSyncRequestEnvelope,
  type RallarCrdtSyncResponseEnvelope,
  type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';

import type {
  RallarServerWsHandler,
  RallarServerWsMessage,
  RallarServerWsMessageContext,
  RallarServerWsTopicDefinition,
} from '../../../rallar-facade/ws-topic-router.ts';
import {
  RALLAR_CRDT_SERVER_DEFAULT_MAX_SYNC_BYTES,
  RALLAR_CRDT_SERVER_DEFAULT_MAX_UPDATE_BYTES,
  type RallarCrdtServerAcceptedEnvelope,
  type RallarCrdtServerEnvelopeKind,
  type RallarCrdtServerTopicBridge,
  type RallarCrdtServerTopicBridgeOptions,
  type RallarCrdtServerTopicScope,
  type RallarCrdtServerTrustedMetadata,
  type RallarCrdtServerWsTopicInstaller,
} from './rallar-crdt-server-contracts.ts';
import { validateRallarCrdtServerLiveEnvelope } from './validate-rallar-crdt-server-live-envelope.ts';

interface RallarCrdtEnvelopeByKind {
  readonly update: RallarCrdtUpdateEnvelope;
  readonly 'sync-request': RallarCrdtSyncRequestEnvelope;
  readonly 'sync-response': RallarCrdtSyncResponseEnvelope;
  readonly 'catch-up-request': RallarCrdtCatchUpRequestEnvelope;
  readonly 'catch-up-response': RallarCrdtCatchUpResponseEnvelope;
}

interface RallarCrdtAcceptedEnvelope<K extends RallarCrdtServerEnvelopeKind> {
  readonly kind: K;
  readonly envelope: RallarCrdtEnvelopeByKind[K];
  readonly trusted: RallarCrdtServerTrustedMetadata;
  readonly raw: ALMessage;
}

type RallarCrdtAcceptedEnvelopeByKind<K extends RallarCrdtServerEnvelopeKind> =
  K extends RallarCrdtServerEnvelopeKind ? RallarCrdtAcceptedEnvelope<K> : never;

export function installRallarCrdtWsTopics(
  ws: RallarCrdtServerWsTopicInstaller,
  options: RallarCrdtServerTopicBridgeOptions = {},
): RallarCrdtServerTopicBridge {
  const definitions = [
    createRallarCrdtTopicDefinition({ kind: 'update', topicScope: 'room', options }),
    createRallarCrdtTopicDefinition({ kind: 'sync-request', topicScope: 'room', options }),
    createRallarCrdtTopicDefinition({ kind: 'sync-response', topicScope: 'room', options }),
    createRallarCrdtTopicDefinition({ kind: 'catch-up-request', topicScope: 'room', options }),
    createRallarCrdtTopicDefinition({ kind: 'catch-up-response', topicScope: 'room', options }),
    createRallarCrdtTopicDefinition({ kind: 'update', topicScope: 'app', options }),
    createRallarCrdtTopicDefinition({ kind: 'sync-request', topicScope: 'app', options }),
    createRallarCrdtTopicDefinition({ kind: 'sync-response', topicScope: 'app', options }),
    createRallarCrdtTopicDefinition({ kind: 'catch-up-request', topicScope: 'app', options }),
    createRallarCrdtTopicDefinition({ kind: 'catch-up-response', topicScope: 'app', options }),
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

interface CreateRallarCrdtTopicDefinitionInput {
  readonly kind: RallarCrdtServerEnvelopeKind;
  readonly topicScope: RallarCrdtServerTopicScope;
  readonly options: RallarCrdtServerTopicBridgeOptions;
}

function createRallarCrdtTopicDefinition(
  input: CreateRallarCrdtTopicDefinitionInput,
): RallarServerWsTopicDefinition {
  const typeId = toTypeId(input.kind);
  const maxPayloadBytes =
    input.kind === 'update'
      ? (input.options.maxUpdateBytes ?? RALLAR_CRDT_SERVER_DEFAULT_MAX_UPDATE_BYTES)
      : (input.options.maxSyncBytes ?? RALLAR_CRDT_SERVER_DEFAULT_MAX_SYNC_BYTES);

  return {
    topicId: toTopicId(input.topicScope),
    typeId,
    scope: input.topicScope,
    maxPayloadBytes,
    fanout:
      input.kind === 'update' || (input.kind === 'catch-up-request' && input.options.logRepository)
        ? 'none'
        : (input.options.fanout ?? 'live-only'),
    validate: (value, context) =>
      validateRallarCrdtServerLiveEnvelope({
        kind: input.kind,
        topicScope: input.topicScope,
        value,
        context: {
          topicId: context.definition?.topicId ?? toTopicId(input.topicScope),
          typeId,
          roomId: context.roomId,
          roomRef: context.roomRef,
        },
        options: input.options,
      }).valid,
    authorize:
      input.options.authorizeDocument || input.options.policies?.length
        ? async (message, context) =>
            await authorizeAcceptedEnvelope({
              kind: input.kind,
              message,
              context,
              options: input.options,
            })
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

    const accepted = toAcceptedEnvelope(kind, message, context);
    if (accepted.kind === 'update' && options.mutationIngress) {
      await options.mutationIngress.enqueueUpdate(accepted);
    } else if (accepted.kind === 'catch-up-request' && options.logRepository) {
      await respondToDurableCatchUpRequest({ accepted, context, options });
    }

    await options.onAcceptedEnvelope?.(accepted);
  };
}

interface RespondToDurableCatchUpRequestInput {
  readonly accepted: Extract<RallarCrdtServerAcceptedEnvelope, { kind: 'catch-up-request' }>;
  readonly context: RallarServerWsMessageContext<unknown>;
  readonly options: RallarCrdtServerTopicBridgeOptions;
}

async function respondToDurableCatchUpRequest(
  input: RespondToDurableCatchUpRequestInput,
): Promise<void> {
  const repository = input.options.logRepository;
  if (!repository) {
    return;
  }

  const page = await repository.listAfter({
    document: input.accepted.envelope.document,
    afterSequence: input.accepted.envelope.afterSequence,
    afterCursor: input.accepted.envelope.afterCursor,
    limit: input.accepted.envelope.maxUpdateCount,
  });
  const snapshot =
    input.accepted.envelope.includeSnapshot === false
      ? undefined
      : await repository.readSnapshot(input.accepted.envelope.document);
  const response: RallarCrdtCatchUpResponseEnvelope = {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    requestId: input.accepted.envelope.requestId,
    document: input.accepted.envelope.document,
    createdAtEpochMs: Date.now(),
    snapshot,
    page,
  };

  await input.context.proxy.toPeer(
    input.context.senderId,
    newALUntargetedMessage(
      input.context.service.name,
      newALEventRoute(
        input.accepted.raw.route.topicId,
        input.accepted.raw.route.contextId,
        input.accepted.envelope.requestId,
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
  const document = readEnvelopeDocument(input.message.payload);
  if (!document) {
    return false;
  }

  const policyDecision = evaluateRallarCrdtFeaturePolicy({
    document,
    operation:
      input.kind === 'update'
        ? 'ws-send'
        : input.kind === 'catch-up-request'
          ? 'durable-catch-up'
          : 'peer-catch-up',
    policies: input.options.policies,
  });
  if (!policyDecision.allowed) {
    return false;
  }

  return await Promise.resolve(
    input.options.authorizeDocument?.({
      kind: input.kind,
      document,
      envelope: input.message.payload,
      trusted: toTrustedMetadata(input.message, input.context),
      raw: input.message.raw,
    }) ?? true,
  );
}

function toAcceptedEnvelope<K extends RallarCrdtServerEnvelopeKind>(
  kind: K,
  message: RallarServerWsMessage<unknown>,
  context: RallarServerWsMessageContext<unknown>,
): RallarCrdtAcceptedEnvelopeByKind<K> {
  // The topic router invokes this handler only after validating the payload for this type ID.
  return {
    kind,
    envelope: message.payload as RallarCrdtEnvelopeByKind[K],
    trusted: toTrustedMetadata(message, context),
    raw: message.raw,
  } as RallarCrdtAcceptedEnvelopeByKind<K>;
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

function readEnvelopeDocument(
  value: unknown,
): RallarCrdtServerAcceptedEnvelope['envelope']['document'] | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const document = Reflect.get(value, 'document');
  return document && typeof document === 'object'
    ? (document as RallarCrdtServerAcceptedEnvelope['envelope']['document'])
    : undefined;
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
