import { AppTopics } from '@shared/api/api-config.ts';
import {
  GROUP_FORMATION_MUTATION_OUTCOMES,
  type GroupFormationMutationOutcome,
  type GroupFormationOperationKind,
  type RallarGroupFormationMetrics,
} from '@shared/rtc/group-formation-metrics.ts';
import type {
  WsDeliveryDiagnosticsEvent,
  WsDeliveryDiagnosticsSink,
} from '@shared/services/ws-queue-box-server-contracts.ts';

import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from './services/rtc-topology-outbox-entry.ts';

export {
  GROUP_FORMATION_MUTATION_OUTCOMES,
  GROUP_FORMATION_OPERATION_KINDS,
  type GroupFormationMutationOutcome,
  type GroupFormationMutationOutcomeCounts,
  type GroupFormationOperationKind,
  type RallarGroupFormationMetrics,
} from '@shared/rtc/group-formation-metrics.ts';

export type GroupFormationGroupMutationEvent = Readonly<{
  operation: string;
  outcome: GroupFormationMutationOutcome;
}>;

export type GroupFormationGroupMutationSink = (event: GroupFormationGroupMutationEvent) => void;

export type GroupFormationPresenceSummaryEvent = Readonly<{
  downstreamTopicIds: readonly string[];
}>;

export type GroupFormationPresenceSummarySink = (
  event: GroupFormationPresenceSummaryEvent,
) => void;

export type GroupFormationRttMutationEvent = Readonly<{
  recomputeIntentCount: number;
}>;

export type GroupFormationRttMutationSink = (event: GroupFormationRttMutationEvent) => void;

export type RallarGroupFormationMetricsRecorder = Readonly<{
  groupMutation: GroupFormationGroupMutationSink;
  presenceSummary: GroupFormationPresenceSummarySink;
  rttMutation: GroupFormationRttMutationSink;
  wsDelivery: WsDeliveryDiagnosticsSink;
  topologyOutboxWritten: () => void;
  readMetrics: () => RallarGroupFormationMetrics;
  resetMetrics: () => void;
}>;

// Keeps the by-topic dimension bounded even if a caller sends unexpected topic ids.
const MAX_TRACKED_TOPIC_COUNT = 50;
const TOPIC_OVERFLOW_KEY = 'untracked-topic-overflow';

interface MutableOutcomeCounts {
  write: number;
  noOp: number;
  rejected: number;
}

interface MutableGroupFormationMetrics {
  groupMutationCount: Record<GroupFormationOperationKind, MutableOutcomeCounts>;
  presenceSummaryExpansionCount: number;
  presenceSummaryWsRowCount: { event: number; snapshot: number; directory: number };
  presenceSummaryTopologyEntryCount: number;
  topologyRecomputeTriggeredCount: number;
  wsOutboxSendCountByTopicId: Record<string, number>;
  wsOutboxRecipientCountByTopicId: Record<string, number>;
  wsEgressBytesByTopicId: Record<string, number>;
  wsOutboxNoLocalRecipientCount: number;
  rttAcceptedWriteCount: number;
  rttRecomputeIntentCount: number;
}

export function emptyGroupFormationMetrics(): RallarGroupFormationMetrics {
  return createMutableGroupFormationMetrics();
}

export function toGroupFormationOperationKind(operation: string): GroupFormationOperationKind {
  switch (operation) {
    case 'joinGroup':
    case 'acceptGroupInvite':
      return 'join';
    case 'connectPresence':
      return 'presenceConnect';
    case 'heartbeatPresence':
      return 'heartbeat';
    case 'disconnectPresence':
      return 'disconnect';
    case 'upsertMember':
    case 'removeGroupMember':
    case 'banGroupMember':
    case 'unbanGroupMember':
    case 'setGroupMemberRole':
    case 'transferGroupOwnership':
      return 'membership';
    default:
      return 'other';
  }
}

export function createGroupFormationMetricsRecorder(): RallarGroupFormationMetricsRecorder {
  let metrics = createMutableGroupFormationMetrics();

  const groupMutation: GroupFormationGroupMutationSink = (event) => {
    try {
      const kind = toGroupFormationOperationKind(event.operation);
      const outcome = isGroupFormationMutationOutcome(event.outcome) ? event.outcome : 'rejected';
      metrics.groupMutationCount[kind][outcome] += 1;
    } catch {
      // Recording must never affect mutation behavior.
    }
  };

  const presenceSummary: GroupFormationPresenceSummarySink = (event) => {
    try {
      metrics.presenceSummaryExpansionCount += 1;
      for (const topicId of event.downstreamTopicIds) {
        if (topicId === AppTopics.groupStateEvent) {
          metrics.presenceSummaryWsRowCount.event += 1;
        } else if (topicId === AppTopics.groupStateSnapshot) {
          metrics.presenceSummaryWsRowCount.snapshot += 1;
        } else if (topicId === AppTopics.groupDirectorySnapshot) {
          metrics.presenceSummaryWsRowCount.directory += 1;
        } else if (topicId === APP_OUTBOX_RTC_TOPOLOGY_TOPIC) {
          metrics.presenceSummaryTopologyEntryCount += 1;
          metrics.topologyRecomputeTriggeredCount += 1;
        }
      }
    } catch {
      // Recording must never affect presence-summary behavior.
    }
  };

  const rttMutation: GroupFormationRttMutationSink = (event) => {
    try {
      metrics.rttAcceptedWriteCount += 1;
      if (Number.isSafeInteger(event.recomputeIntentCount) && event.recomputeIntentCount > 0) {
        metrics.rttRecomputeIntentCount += event.recomputeIntentCount;
      }
    } catch {
      // Recording must never affect RTT mutation behavior.
    }
  };

  const wsDelivery: WsDeliveryDiagnosticsSink = (event: WsDeliveryDiagnosticsEvent) => {
    try {
      if (event.kind === 'live-send') {
        incrementByTopic(metrics.wsOutboxSendCountByTopicId, event.topicId, 1);
        incrementByTopic(
          metrics.wsOutboxRecipientCountByTopicId,
          event.topicId,
          event.recipientCount,
        );
        incrementByTopic(
          metrics.wsEgressBytesByTopicId,
          event.topicId,
          event.payloadBytes * event.sentCount,
        );
      } else if (event.kind === 'outbox-send') {
        incrementByTopic(metrics.wsOutboxSendCountByTopicId, event.topicId, 1);
        incrementByTopic(metrics.wsOutboxRecipientCountByTopicId, event.topicId, 1);
        incrementByTopic(metrics.wsEgressBytesByTopicId, event.topicId, event.payloadBytes);
      } else if (event.kind === 'no-local-recipient') {
        metrics.wsOutboxNoLocalRecipientCount += 1;
      }
    } catch {
      // Recording must never affect WS delivery behavior.
    }
  };

  const topologyOutboxWritten = (): void => {
    metrics.topologyRecomputeTriggeredCount += 1;
  };

  return {
    groupMutation,
    presenceSummary,
    rttMutation,
    wsDelivery,
    topologyOutboxWritten,
    readMetrics: () => structuredClone(metrics),
    resetMetrics: () => {
      metrics = createMutableGroupFormationMetrics();
    },
  };
}

function createMutableGroupFormationMetrics(): MutableGroupFormationMetrics {
  return {
    groupMutationCount: {
      join: emptyOutcomeCounts(),
      presenceConnect: emptyOutcomeCounts(),
      heartbeat: emptyOutcomeCounts(),
      disconnect: emptyOutcomeCounts(),
      membership: emptyOutcomeCounts(),
      other: emptyOutcomeCounts(),
    },
    presenceSummaryExpansionCount: 0,
    presenceSummaryWsRowCount: { event: 0, snapshot: 0, directory: 0 },
    presenceSummaryTopologyEntryCount: 0,
    topologyRecomputeTriggeredCount: 0,
    wsOutboxSendCountByTopicId: {},
    wsOutboxRecipientCountByTopicId: {},
    wsEgressBytesByTopicId: {},
    wsOutboxNoLocalRecipientCount: 0,
    rttAcceptedWriteCount: 0,
    rttRecomputeIntentCount: 0,
  };
}

function emptyOutcomeCounts(): MutableOutcomeCounts {
  return { write: 0, noOp: 0, rejected: 0 };
}

function isGroupFormationMutationOutcome(value: string): value is GroupFormationMutationOutcome {
  return (GROUP_FORMATION_MUTATION_OUTCOMES as readonly string[]).includes(value);
}

function incrementByTopic(counts: Record<string, number>, topicId: string, amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return;
  }
  const key =
    topicId in counts || Object.keys(counts).length < MAX_TRACKED_TOPIC_COUNT
      ? topicId
      : TOPIC_OVERFLOW_KEY;
  counts[key] = (counts[key] ?? 0) + amount;
}
