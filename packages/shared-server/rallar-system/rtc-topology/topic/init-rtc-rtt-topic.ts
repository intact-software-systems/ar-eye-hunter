import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics, type RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import * as rttRepository from '@shared/repository/rtt-repository.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { computeGlobalGraphAndCacheIt } from '@shared-graph/group-graphs-create-service.ts';
import { predictedRttMs } from '@shared-graph/graph/vivaldi.ts';
import * as vivaldiService from '@shared-graph/vivaldi-service.ts';

import type { RtcRttRefinementGate } from './rtc-rtt-refinement-gate.ts';

import type { RtcTopologyRuntimeState } from '../../ws-rtc-topology-runtime.ts';
import type { RtcTopologyWorkPublisher } from '../../services/RtcTopologyOutboxWork.ts';
import type { GroupTopologyGroupSnapshotReader } from '../../topology/group-topology-management-service.ts';
import type { RallarRtcTopologyService } from '../../services/rallar-rtc-topology-service.ts';
import {
  evaluateRtcRttMeasurement,
  type RtcRttAcceptanceResult,
} from '../policy/rtc-rtt-measurement-policy.ts';

interface InitRtcRttTopicOptions {
  readonly wsQueueBoxServerService: WsQueueBoxServerService;
  readonly rtcTopologyService: RallarRtcTopologyService;
  readonly rtcTopologyWorkPublisher?: RtcTopologyWorkPublisher;
  readonly runtimeState?: RtcTopologyRuntimeState;
  readonly persistentRuntimeDeclared: boolean;
  readonly rttRefinementGate?: RtcRttRefinementGate;
  readonly scheduleGlobalGraphRttRecompute: () => void;
  readonly findGroupSnapshotByRef?: GroupTopologyGroupSnapshotReader;
  readonly enqueueRtcRttMutation?: (
    input: Readonly<{
      rtt: RttMeasurementInfo;
      alSenderId: string;
      capturedAtEpochMs: number;
    }>,
  ) => Promise<ResourceEntry>;
}

interface RtcRttPolicyInputs {
  readonly candidateGroups: readonly GroupSnapshot[];
  readonly overlaySnapshotsByGroupKey: ReadonlyMap<string, RallarOverlayTopologySnapshot>;
  readonly degreeLimit: number;
}

export function initRtcRttTopic(options: InitRtcRttTopicOptions): void {
  options.wsQueueBoxServerService.onInboxMessageDo(AppTopics.rtt, {
    onMessage: async (data: ALMessage, _: ResourceEntry, _server: JsonWebSocketServer) => {
      if (data.route.topicId !== AppTopics.rtt) return;
      const rtt = JSON.parse(data.payload.resource) as RttMeasurementInfo;
      console.log(`Received RTT message: ${data.payload.resource}`);

      if (options.persistentRuntimeDeclared) {
        if (!options.enqueueRtcRttMutation) {
          throw new TypeError('RTC RTT persistence requires durable AppInbox enqueue');
        }
        await options.enqueueRtcRttMutation({
          rtt,
          alSenderId: data.id.senderId,
          capturedAtEpochMs: Date.now(),
        });
        return;
      }

      const readPolicyInputs = async (): Promise<RtcRttPolicyInputs> => {
        const candidateGroups = await findGroupsAffectedByRtt(
          rtt,
          data,
          options.findGroupSnapshotByRef,
        );
        return {
          candidateGroups,
          overlaySnapshotsByGroupKey: await readOverlaySnapshotsForGroups(
            candidateGroups,
            options.rtcTopologyService,
            options.runtimeState,
          ),
          degreeLimit: options.rtcTopologyService.readRttReportingDegreeLimit(),
        };
      };
      const acceptance = await acceptRtcRttMeasurementWithPolicy({
        rtt,
        alSenderId: data.id.senderId,
        readPolicyInputs,
      });
      if (!acceptance.accepted) {
        console.warn(`Rejected RTC RTT measurement: ${acceptance.reason}`);
        return;
      }
      if (!acceptance.updated) return;

      const predictedDeltaMs = observeRttWithPredictedDelta(rtt);
      options.scheduleGlobalGraphRttRecompute();
      if (options.rtcTopologyWorkPublisher && !options.runtimeState) {
        const refinementGroups = resolveRttRefinementGroups(
          acceptance.affectedGroups,
          predictedDeltaMs,
          options.rttRefinementGate,
        );
        if (refinementGroups.length > 0) {
          await options.rtcTopologyWorkPublisher.enqueueForRttGroups(
            rtt,
            refinementGroups,
            options.rtcTopologyService.readRttRebuildDebounceMs(),
          );
        }
      }
    },
  });
}

/**
 * The Vivaldi delta for a report is how far the pair's predicted RTT moved
 * when the observation was applied; the first observation of a pair has no
 * prediction and always counts as refinement-worthy placement knowledge.
 */
function observeRttWithPredictedDelta(rtt: RttMeasurementInfo): number {
  const predictedBefore = readPredictedPairRttMs(rtt);
  vivaldiService.observeRtt(rtt);
  const predictedAfter = readPredictedPairRttMs(rtt);
  if (predictedBefore === undefined || predictedAfter === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(predictedAfter - predictedBefore);
}

function readPredictedPairRttMs(rtt: RttMeasurementInfo): number | undefined {
  const nodes = vivaldiService.readablePredictedNodeData();
  const fromNode = nodes.get(rtt.sessionIdFrom);
  const toNode = nodes.get(rtt.sessionIdTo);
  if (!fromNode || !toNode) {
    return undefined;
  }
  return predictedRttMs(fromNode, toNode);
}

function resolveRttRefinementGroups(
  affectedGroups: readonly GroupSnapshot[],
  predictedDeltaMs: number,
  refinementGate: RtcRttRefinementGate | undefined,
): readonly GroupSnapshot[] {
  if (!refinementGate) {
    return affectedGroups;
  }
  return affectedGroups.filter((group) =>
    refinementGate.claimRefinement({
      groupKey: toWebRtcGroupKey(group.group),
      predictedDeltaMs,
      nowEpochMs: Date.now(),
    }),
  );
}

export function computeGlobalGraphAndCacheItIfPossible(predictedDegreeLimit?: number): void {
  try {
    computeGlobalGraphAndCacheIt(
      predictedDegreeLimit !== undefined ? { predictedDegreeLimit } : {},
    );
  } catch (error) {
    console.warn(
      `Skipping global graph cache recompute after partial RTT update: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function findGroupsAffectedByRtt(
  rtt: RttMeasurementInfo,
  message: ALMessage,
  findGroupSnapshotByRef?: GroupTopologyGroupSnapshotReader,
): Promise<readonly GroupSnapshot[]> {
  const groupRef = readALTargetGroupRef(message);
  if (groupRef && findGroupSnapshotByRef) {
    const snapshot = await findGroupSnapshotByRef(groupRef);
    return snapshot ? [snapshot] : [];
  }
  return groupStateSnapshotsRepository.findGroupStateSnapshotsBySessionIds([
    rtt.sessionIdFrom,
    rtt.sessionIdTo,
  ]);
}

type RtcRttUpdateResult = RtcRttAcceptanceResult & Readonly<{ updated: boolean }>;

async function acceptRtcRttMeasurementWithPolicy(
  input: Readonly<{
    rtt: RttMeasurementInfo;
    alSenderId: string;
    readPolicyInputs: () => Promise<RtcRttPolicyInputs>;
  }>,
): Promise<RtcRttUpdateResult> {
  const requestedAtEpochMs = Date.now();
  const result = evaluateRtcRttMeasurement({
    rtt: input.rtt,
    alSenderId: input.alSenderId,
    requestedAtEpochMs,
    ...(await input.readPolicyInputs()),
    existingMeasurements: rttRepository.getAllRtt(),
  });
  return {
    ...result,
    updated: result.accepted ? rttRepository.setRtt(input.rtt) : false,
  };
}

async function readOverlaySnapshotsForGroups(
  groups: readonly GroupSnapshot[],
  rtcTopologyService: RallarRtcTopologyService,
  runtimeState?: RtcTopologyRuntimeState,
): Promise<ReadonlyMap<string, RallarOverlayTopologySnapshot>> {
  const snapshots = new Map<string, RallarOverlayTopologySnapshot>();
  for (const group of groups) {
    const snapshot = runtimeState
      ? await runtimeState.topologySnapshots.findSnapshot(group.group)
      : rtcTopologyService.readSnapshot(group);
    if (snapshot) snapshots.set(toWebRtcGroupKey(group.group), snapshot);
  }
  return snapshots;
}
