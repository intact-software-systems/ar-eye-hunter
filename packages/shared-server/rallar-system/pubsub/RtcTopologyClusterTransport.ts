import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import { rtcTopologySemanticEqual } from '../rtc-topology-semantic-equality.ts';
import type {
  RtcTopologyPublication,
  RtcTopologyPublicationRepository,
} from '../repositories/RtcTopologyPublicationRepository.ts';

export const RTC_TOPOLOGY_PUBLICATION_CHANNEL = 'rallar_rtc_topology_publication';

export type RtcTopologyPublicationNotificationV1 = Readonly<{
  v: 1;
  publisherId: string;
  publicationId: string;
  sourceGroupStateRevision: number;
}>;

export type RtcTopologyPublicationNotificationV2 = Readonly<{
  v: 2;
  publisherId: string;
  groupRef: GroupRef;
  publicationId: string;
  sourceGroupStateCausalRevision: GroupStateCausalRevision;
}>;

export type RtcTopologyPublicationNotification =
  RtcTopologyPublicationNotificationV1 | RtcTopologyPublicationNotificationV2;

export type RtcTopologyClusterTransport = Readonly<{
  publish(channel: string, notification: RtcTopologyPublicationNotification): Promise<void>;
  subscribe(
    channel: string,
    listener: (notification: RtcTopologyPublicationNotification) => void | Promise<void>,
  ): Promise<void>;
}>;

export type LocalRtcTopologyClusterBus = Readonly<{
  listenersByChannel: Map<
    string,
    Set<(notification: RtcTopologyPublicationNotification) => void | Promise<void>>
  >;
}>;

const defaultLocalBus = createLocalRtcTopologyClusterBus();

export function createLocalRtcTopologyClusterBus(): LocalRtcTopologyClusterBus {
  return { listenersByChannel: new Map() };
}

export function createLocalRtcTopologyClusterTransport(
  bus: LocalRtcTopologyClusterBus = defaultLocalBus,
): RtcTopologyClusterTransport {
  return {
    publish: async (channel, notification) => {
      const listeners = bus.listenersByChannel.get(channel);
      if (!listeners) {
        return;
      }
      for (const listener of [...listeners]) {
        await listener(notification);
      }
    },
    subscribe: async (channel, listener) => {
      let listeners = bus.listenersByChannel.get(channel);
      if (!listeners) {
        listeners = new Set();
        bus.listenersByChannel.set(channel, listeners);
      }
      listeners.add(listener);
    },
  };
}

export function createDisabledRtcTopologyClusterTransport(): RtcTopologyClusterTransport {
  return {
    publish: async () => {},
    subscribe: async () => {},
  };
}

/**
 * @deprecated Durable per-process topology streams and replay own production
 * cross-process delivery. Retained for public compatibility only.
 */
export type RtcTopologyPublicationFanout = Readonly<{
  readiness: Promise<void>;
  publish(publication: RtcTopologyPublication): Promise<number>;
  deliverLocal(publication: RtcTopologyPublication): number;
}>;

/** @deprecated Retained for public compatibility; do not use in production composition. */
export function createRtcTopologyPublicationFanout(
  options: Readonly<{
    publisherId: string;
    repository: RtcTopologyPublicationRepository;
    transport: RtcTopologyClusterTransport;
    server: JsonWebSocketServer;
    channel?: string;
  }>,
): RtcTopologyPublicationFanout {
  const channel = options.channel ?? RTC_TOPOLOGY_PUBLICATION_CHANNEL;
  const deliverLocal = (publication: RtcTopologyPublication): number => {
    const recipients = new Set(publication.recipientSessionIds);
    const encoded = options.server.encode(publication.message);
    let delivered = 0;
    for (const connectionId of recipients) {
      if (options.server.trySendEncoded(connectionId, encoded)) {
        delivered += 1;
      }
    }
    return delivered;
  };
  const readiness = options.transport.subscribe(channel, async (notification) => {
    if (
      !isRtcTopologyPublicationNotification(notification) ||
      notification.publisherId === options.publisherId
    ) {
      return;
    }
    // v1 predates scoped publication keys. Its validated global lookup is
    // retained only for rolling-deployment compatibility; v2 is the
    // canonical scoped protocol emitted by current writers.
    const publication =
      notification.v === 1
        ? await options.repository.findPublication(notification.publicationId)
        : await options.repository.findPublication(
            notification.groupRef,
            notification.publicationId,
          );
    if (
      !publication ||
      (notification.v === 1
        ? publication.sourceGroupStateCausalRevision.groupRevision !==
          notification.sourceGroupStateRevision
        : !rtcTopologySemanticEqual(
            publication.sourceGroupStateCausalRevision,
            notification.sourceGroupStateCausalRevision,
          ))
    ) {
      return;
    }
    deliverLocal(publication);
  });

  return {
    readiness,
    deliverLocal,
    publish: async (publication) => {
      const localRecipientCount = deliverLocal(publication);
      await options.transport.publish(channel, {
        v: 2,
        publisherId: options.publisherId,
        groupRef: canonicalGroupRef(publication.groupRef),
        publicationId: publication.publicationId,
        sourceGroupStateCausalRevision: publication.sourceGroupStateCausalRevision,
      });
      return localRecipientCount;
    },
  };
}

export function isRtcTopologyPublicationNotification(
  value: unknown,
): value is RtcTopologyPublicationNotification {
  if (!isObjectRecord(value)) {
    return false;
  }
  const notification = value;
  const commonFieldsAreValid =
    typeof notification.publisherId === 'string' &&
    notification.publisherId.length > 0 &&
    typeof notification.publicationId === 'string' &&
    notification.publicationId.length > 0;
  if (!commonFieldsAreValid) return false;
  if (notification.v === 1) {
    return (
      typeof notification.sourceGroupStateRevision === 'number' &&
      Number.isSafeInteger(notification.sourceGroupStateRevision) &&
      notification.sourceGroupStateRevision >= 0 &&
      hasExactKeys(notification, ['v', 'publisherId', 'publicationId', 'sourceGroupStateRevision'])
    );
  }
  return (
    notification.v === 2 &&
    isGroupStateCausalRevision(notification.sourceGroupStateCausalRevision) &&
    hasExactKeys(notification, [
      'v',
      'publisherId',
      'groupRef',
      'publicationId',
      'sourceGroupStateCausalRevision',
    ]) &&
    isCanonicalGroupRef(notification.groupRef)
  );
}

function isGroupStateCausalRevision(value: unknown): value is GroupStateCausalRevision {
  if (!isObjectRecord(value)) {
    return false;
  }
  return (
    hasExactKeys(value, ['groupRevision', 'presenceRevision']) &&
    Number.isSafeInteger(value.groupRevision) &&
    Number(value.groupRevision) >= 0 &&
    Number.isSafeInteger(value.presenceRevision) &&
    Number(value.presenceRevision) >= 0
  );
}

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
  return rtcTopologySemanticEqual(Object.keys(value).sort(), [...expectedKeys].sort());
}

function canonicalGroupRef(ref: GroupRef): GroupRef {
  return {
    applicationId: ref.applicationId,
    workspaceId: ref.workspaceId,
    groupId: ref.groupId,
  };
}

function isCanonicalGroupRef(value: unknown): value is GroupRef {
  if (!isObjectRecord(value)) return false;
  const expectedKeys = ['applicationId', 'workspaceId', 'groupId'];
  return (
    rtcTopologySemanticEqual(Object.keys(value).sort(), expectedKeys.sort()) &&
    typeof value.applicationId === 'string' &&
    value.applicationId.length > 0 &&
    typeof value.groupId === 'string' &&
    value.groupId.length > 0 &&
    typeof value.workspaceId === 'string'
  );
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
