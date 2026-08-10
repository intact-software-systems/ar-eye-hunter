import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

// prettier-ignore
import {
  DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
} from '../../repositories/RtcTopologyPublicationRepository.ts';
import { toRtcTopologyPublicationMessageId } from '../../rtc-topology-identifiers.ts';

export interface RtcOverlayTopologyMessageFacts {
  readonly workId: string;
  readonly createdAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

/** @deprecated Compatibility helper for non-retry publication paths only. */
export function createRtcOverlayTopologyBroadcastMessage(
  group: GroupSnapshot,
  snapshot: RallarOverlayTopologySnapshot,
): ALMessage {
  const createdAtEpochMs = Date.now();
  return materializeRtcOverlayTopologyBroadcastMessage(group, snapshot, {
    workId: crypto.randomUUID(),
    createdAtEpochMs,
    expiresAtEpochMs: createdAtEpochMs + DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
  });
}

export function materializeRtcOverlayTopologyBroadcastMessage(
  group: GroupSnapshot,
  snapshot: RallarOverlayTopologySnapshot,
  facts: RtcOverlayTopologyMessageFacts,
): ALMessage {
  validateRtcOverlayTopologyMessageFacts(facts);
  return {
    id: {
      v: 2,
      msgId: toRtcTopologyPublicationMessageId(facts.workId),
      ts: facts.createdAtEpochMs,
      senderId: 'rallar-server',
    },
    route: {
      topicId: AppTopics.overlayTopology,
      contextId: group.group.groupId,
      resourceId:
        `${snapshot.overlayId}:` +
        `${snapshot.sourceGroupStateCausalRevision.groupRevision}:` +
        `${snapshot.sourceGroupStateCausalRevision.presenceRevision}:` +
        `${snapshot.version}`,
    },
    constraints: { expiresAtMs: facts.expiresAtEpochMs },
    targets: {
      mode: 'broadcast',
      scope: 'room',
      groupRef: canonicalGroupRef(group),
      minSnapshotVersion: group.group.snapshotVersion,
    },
    delivery: { reliability: 'best-effort', ack: 'none' },
    payload: {
      typeId: AppTopics.overlayTopology,
      contentType: 'application/json',
      resource: JSON.stringify(snapshot),
    },
    audit: { createdBy: 'rallar-server', createdTs: facts.createdAtEpochMs },
  };
}

function validateRtcOverlayTopologyMessageFacts(facts: RtcOverlayTopologyMessageFacts): void {
  if (
    facts.workId.length === 0 ||
    !Number.isSafeInteger(facts.createdAtEpochMs) ||
    facts.createdAtEpochMs < 0 ||
    !Number.isSafeInteger(facts.expiresAtEpochMs) ||
    facts.expiresAtEpochMs <= facts.createdAtEpochMs
  ) {
    throw new TypeError('RTC topology publication message facts are invalid');
  }
}

function canonicalGroupRef(group: GroupSnapshot) {
  return {
    applicationId: group.group.applicationId,
    workspaceId: group.group.workspaceId,
    groupId: group.group.groupId,
  };
}
