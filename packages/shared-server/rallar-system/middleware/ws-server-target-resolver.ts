import { type ALMessage, readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { isSameGroupScope } from '@shared/api/api-type-utils.ts';
import {
  compareGroupCausalRevision,
  readGroupCausalRevision,
} from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type {
  WsServerResolvedRecipient,
  WsServerTargetResolver,
} from '@shared/services/WsQueueBoxServerService.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { isClientSnapshotSessionLive, isGroupSnapshotSessionLive } from '../snapshot-presence.ts';
import { readGroupSnapshotStateSyncPayload } from '../state-sync/state-sync-payload.ts';
import { resolveStateSyncRecipients } from '../state-sync-routing.ts';
import type { RallarGroupSnapshotResolverOptions } from './rallar-middleware-options.ts';

export function createWsServerTargetResolver(
  webSocketServer: JsonWebSocketServer,
  options: RallarGroupSnapshotResolverOptions = {},
): WsServerTargetResolver {
  const resolveGroupSnapshot = (
    groupId: string,
    message: ALMessage,
  ): GroupSnapshot | undefined => {
    const groupRef = readALTargetGroupRef(message) ??
      options.resolveGroupRef?.(groupId, message);
    const scopedSnapshot = groupRef
      ? options.findGroupSnapshotByRef?.(groupRef, message)
      : undefined;
    const knownSnapshot = scopedSnapshot ?? resolveGroupSnapshotById(groupId, groupRef);
    // A group-snapshot row carries its own authoritative membership; when a
    // process-local cache lags the row (no storm keeps caches warm under
    // damped formation), the causally newest snapshot resolves the audience.
    const payloadSnapshot = readGroupSnapshotPayloadForGroup(groupId, message);
    if (!payloadSnapshot) return knownSnapshot;
    if (!knownSnapshot) return payloadSnapshot;
    return compareGroupCausalRevision(
        readGroupCausalRevision(payloadSnapshot),
        readGroupCausalRevision(knownSnapshot),
      ) === 'dominated'
      ? knownSnapshot
      : payloadSnapshot;
  };
  const resolveGroupSnapshotById = (
    groupId: string,
    groupRef: ReturnType<typeof readALTargetGroupRef>,
  ): GroupSnapshot | undefined => {
    const byIdSnapshot = options.findGroupSnapshotById?.(groupId);
    if (!byIdSnapshot) return undefined;
    return groupRef === undefined || isSameGroupScope(byIdSnapshot.group, groupRef)
      ? byIdSnapshot
      : undefined;
  };
  const readGroupSnapshotPayloadForGroup = (
    groupId: string,
    message: ALMessage,
  ): GroupSnapshot | undefined => {
    const payloadSnapshot = readGroupSnapshotStateSyncPayload(message);
    return payloadSnapshot && payloadSnapshot.group.groupId === groupId
      ? payloadSnapshot
      : undefined;
  };
  const resolveGroupRecipients = (
    groupId: string,
    message: ALMessage,
  ): readonly WsServerResolvedRecipient[] => {
    const snapshot = resolveGroupSnapshot(groupId, message);
    if (!snapshot) return [];
    return snapshot.activeSessions
      .filter((session) =>
        isGroupSnapshotSessionLive(session, options.now?.() ?? Date.now()) &&
        webSocketServer.connections.get(session.sessionId)?.isOpen
      )
      .map((session) => ({ peerId: session.sessionId, connectionId: session.sessionId }));
  };
  const resolveAllOpenConnections = (
    message: ALMessage,
  ): readonly WsServerResolvedRecipient[] => {
    const stateSyncRecipients = resolveStateSyncRecipients(webSocketServer, message, {
      findGroupSnapshotByRef: (ref) => options.findGroupSnapshotByRef?.(ref, message),
      findGroupSnapshotById: options.findGroupSnapshotById,
      now: options.now,
    });
    return stateSyncRecipients ?? [...webSocketServer.connections.values()]
      .filter((context) => context.isOpen)
      .map((context) => ({ peerId: context.id, connectionId: context.id }));
  };
  const resolveFixedBroadcastRecipients = (
    message: ALMessage,
  ): readonly WsServerResolvedRecipient[] | undefined => {
    const targets = message.targets;
    if (
      targets?.mode !== 'broadcast' ||
      targets.recipientPeerIds === undefined ||
      message.id.senderId !== 'rallar-server' ||
      message.route.topicId !== AppTopics.overlayTopology ||
      message.payload.typeId !== AppTopics.overlayTopology
    ) {
      return undefined;
    }
    return targets.recipientPeerIds.flatMap((peerId) => {
      const context = webSocketServer.connections.get(peerId);
      return context?.isOpen ? [{ peerId, connectionId: peerId }] : [];
    });
  };
  return {
    resolvePeerRecipients: (peerId, message) => {
      const principalRef = readCrdtPrincipalRef(message, peerId);
      const snapshot = principalRef
        ? options.findClientSnapshotByRef?.(principalRef, message)
        : undefined;
      if (snapshot) return snapshot.activeSessions.filter((session) =>
        isClientSnapshotSessionLive(session, options.now?.() ?? Date.now()) &&
        webSocketServer.connections.get(session.sessionId)?.isOpen
      ).map((session) => ({
        peerId: session.sessionId,
        connectionId: session.connectionId ?? session.sessionId,
      }));
      if (principalRef) return [];
      const context = webSocketServer.connections.get(peerId);
      return context?.isOpen ? [{ peerId, connectionId: peerId }] : [];
    },
    resolveGroupRecipients,
    resolveBroadcastRecipients: (scope, message) => {
      const fixedRecipients = resolveFixedBroadcastRecipients(message);
      if (fixedRecipients !== undefined) return fixedRecipients;
      return scope === 'room'
        ? resolveGroupRecipients(
          readALTargetGroupRef(message)?.groupId ?? message.route.contextId,
          message,
        )
        : resolveAllOpenConnections(message);
    },
    resolvePeerIdForConnection: (connectionId) => connectionId,
  };
}

function readCrdtPrincipalRef(message: ALMessage, principalId: string) {
  if (message.payload.typeId !== 'rallar.crdt.update.v1') return undefined;
  try {
    const update = JSON.parse(message.payload.resource) as Record<string, unknown>;
    const document = update.document as Record<string, unknown> | undefined;
    if (
      document?.scope !== 'principal' || document.principalId !== principalId ||
      typeof document.applicationId !== 'string' ||
      ('workspaceId' in document && typeof document.workspaceId !== 'string')
    ) return undefined;
    return {
      applicationId: document.applicationId,
      ...('workspaceId' in document ? { workspaceId: document.workspaceId as string } : {}),
      principalId,
    };
  } catch {
    return undefined;
  }
}
