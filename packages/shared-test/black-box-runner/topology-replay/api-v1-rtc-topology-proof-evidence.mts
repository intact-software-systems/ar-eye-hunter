import type {
  ProofCausalRevision,
  ProofGroupInput,
  ProofJsonObject,
  ProofSession,
  ProofTopologyCheckpoint,
} from './api-v1-rtc-topology-proof-api.mts';
import { requireRecord, requireSafeInteger } from './api-v1-rtc-topology-proof-api.mts';
import {
  assertLivePassiveConsumerState,
  readRtcTopologyProofDurableState,
  type ProofDurableState,
} from './api-v1-rtc-topology-proof-postgres.mts';
import {
  RTC_TOPOLOGY_PROOF_ASSERTION_TIMEOUT_MS,
  type ApiV1RtcTopologyProofSocket,
  type ProofTopologyDeliveryKind,
  type ProofTopologyExpectation,
  type ProofTopologyObservation,
} from './api-v1-rtc-topology-proof-websocket.mts';

const PROOF_POLL_INTERVAL_MS = 100;

export interface ProofReplayMetricDelta extends ProofJsonObject {
  readonly pollWakes: number;
  readonly notificationWakes: number;
  readonly localCommitWakes: number;
  readonly replayedEntryCount: number;
}

interface ProofReplayMetricSnapshot {
  readonly pollWakes: number;
  readonly notificationWakes: number;
  readonly localCommitWakes: number;
  readonly replayedEntryCount: number;
}

export async function waitForPassivePair(
  sockets: readonly ApiV1RtcTopologyProofSocket[],
  expectation: ProofTopologyExpectation,
): Promise<readonly ProofTopologyObservation[]> {
  return await Promise.all([
    sockets[4]!.waitForTopology(expectation),
    sockets[5]!.waitForTopology(expectation),
  ]);
}

export function assertCompleteSessionTopology(
  observations: readonly ProofTopologyObservation[],
  sessions: readonly ProofSession[],
): void {
  const expected = [...sessions.map((session) => session.sessionId)].sort();
  for (const observation of observations) {
    const actual = [...observation.activeSessionIds].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('Proof topology did not contain all six active sessions exactly once.');
    }
  }
}

export function assertPollDrivenReplayMetricDelta(
  before: ProofJsonObject,
  after: ProofJsonObject,
): ProofReplayMetricDelta {
  const beforeMetrics = readReplayMetricSnapshot(before);
  const afterMetrics = readReplayMetricSnapshot(after);
  const pollWakes = afterMetrics.pollWakes - beforeMetrics.pollWakes;
  const notificationWakes = afterMetrics.notificationWakes - beforeMetrics.notificationWakes;
  const localCommitWakes = afterMetrics.localCommitWakes - beforeMetrics.localCommitWakes;
  const replayedEntryCount = afterMetrics.replayedEntryCount - beforeMetrics.replayedEntryCount;
  if (pollWakes < 2 || notificationWakes !== 0 || localCommitWakes !== 0) {
    throw new Error('Passive C replay was not exclusively discovered by repeated polling.');
  }
  if (replayedEntryCount !== 2) {
    throw new Error('Passive C did not replay exactly two post-baseline topology entries.');
  }
  return { pollWakes, notificationWakes, localCommitWakes, replayedEntryCount };
}

export function toProofTopologyPublicationMessageId(
  group: ProofGroupInput,
  requestId: string,
  mutationRevision: ProofCausalRevision,
): string {
  const topologyRevision = toTopologyRevisionAfterMutation(mutationRevision);
  const commandId =
    `app-outbox.rtc-topology:app=${group.applicationId}:` +
    `ws=${group.workspaceId}:group=${group.groupId}:${requestId}`;
  const workId =
    `${commandId}:rtc-topology-recompute:group-revision:` +
    `group=${topologyRevision.groupRevision};presence=${topologyRevision.presenceRevision}:0`;
  return JSON.stringify(['rtc-topology-publication', workId]);
}

export function exactPublicationExpectation(
  group: ProofGroupInput,
  requestId: string,
  mutationRevision: ProofCausalRevision,
): ProofTopologyExpectation {
  return {
    causalRevision: toTopologyRevisionAfterMutation(mutationRevision),
    causalMatch: 'exact',
    deliveryKind: 'publication',
    messageId: toProofTopologyPublicationMessageId(group, requestId, mutationRevision),
  };
}

export function exactTopologyExpectation(
  checkpoint: ProofTopologyCheckpoint,
  deliveryKind: ProofTopologyDeliveryKind,
): ProofTopologyExpectation {
  return {
    causalRevision: checkpoint.causalRevision,
    causalMatch: 'exact',
    version: checkpoint.version,
    deliveryKind,
  };
}

export function assertCheckpointMatchesMutation(
  checkpoint: ProofTopologyCheckpoint,
  mutationRevision: ProofCausalRevision,
): void {
  const expected = toTopologyRevisionAfterMutation(mutationRevision);
  if (
    checkpoint.causalRevision.groupRevision !== expected.groupRevision ||
    checkpoint.causalRevision.presenceRevision !== expected.presenceRevision
  ) {
    throw new Error(
      'Current topology did not match the final mutation before replacement C started.',
    );
  }
}

export async function waitForStablePassiveState(databaseUrl: string): Promise<ProofDurableState> {
  return await waitForStableDurableState(databaseUrl, assertLivePassiveConsumerState);
}

export async function waitForStableRegisteredState(
  databaseUrl: string,
): Promise<ProofDurableState> {
  return await waitForStableDurableState(databaseUrl, (state) => {
    if (state.streams.length !== 3) {
      throw new Error(
        `Expected exactly three registered proof streams; found ${state.streams.length}.`,
      );
    }
    if (state.unresolvedAppOutboxCount !== 0) {
      throw new Error(
        'RTC topology proof still has ' +
          `${state.unresolvedAppOutboxCount} unresolved APP_OUTBOX rows.`,
      );
    }
  });
}

async function waitForStableDurableState(
  databaseUrl: string,
  assertState: (state: ProofDurableState) => void,
): Promise<ProofDurableState> {
  const deadline = Date.now() + RTC_TOPOLOGY_PROOF_ASSERTION_TIMEOUT_MS;
  let previousStateJson: string | undefined;
  let consecutiveStableReads = 0;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    const state = await readRtcTopologyProofDurableState(databaseUrl);
    try {
      assertState(state);
      const stateJson = JSON.stringify(state);
      consecutiveStableReads = stateJson === previousStateJson ? consecutiveStableReads + 1 : 0;
      previousStateJson = stateJson;
      if (consecutiveStableReads >= 2) return state;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      previousStateJson = undefined;
      consecutiveStableReads = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, PROOF_POLL_INTERVAL_MS));
  }
  throw lastError ?? new Error('Timed out waiting for stable passive-C durable state.');
}

export async function waitForDurableState<T>(
  databaseUrl: string,
  assertState: (state: ProofDurableState) => T,
): Promise<ProofDurableState> {
  const deadline = Date.now() + RTC_TOPOLOGY_PROOF_ASSERTION_TIMEOUT_MS;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    const state = await readRtcTopologyProofDurableState(databaseUrl);
    try {
      assertState(state);
      return state;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, PROOF_POLL_INTERVAL_MS));
  }
  throw lastError ?? new Error('Timed out waiting for durable RTC topology proof state.');
}

function readReplayMetricSnapshot(metrics: ProofJsonObject): ProofReplayMetricSnapshot {
  const wakes = requireRecord(metrics.wakeCountBySource, 'replay wake metrics');
  return {
    pollWakes: requireSafeInteger(wakes.poll, 'poll wake count'),
    notificationWakes: requireSafeInteger(wakes.notification, 'notification wake count'),
    localCommitWakes: requireSafeInteger(wakes['local-commit'], 'local commit wake count'),
    replayedEntryCount: requireSafeInteger(metrics.replayedEntryCount, 'replayed entry count'),
  };
}

function toTopologyRevisionAfterMutation(
  mutationRevision: ProofCausalRevision,
): ProofCausalRevision {
  return {
    groupRevision: mutationRevision.groupRevision,
    presenceRevision: requireSafeInteger(
      mutationRevision.presenceRevision + 1,
      'post-mutation topology presence revision',
    ),
  };
}
