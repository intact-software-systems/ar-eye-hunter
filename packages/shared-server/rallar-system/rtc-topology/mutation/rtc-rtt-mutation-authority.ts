import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import type {
  RtcRttMutationCommand,
  RtcRttMutationFacts,
  RtcRttMutationLifecycleFacts,
  RtcRttStableRequest,
} from './rtc-rtt-mutation-contracts.ts';

export function validateRtcRttMutationFacts(facts: RtcRttMutationFacts): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(facts.commandHash)) {
    throw new TypeError('RTC RTT command hash fact is invalid');
  }
  if (!Number.isSafeInteger(facts.attemptCount) || facts.attemptCount < 1) {
    throw new TypeError('RTC RTT attempt count fact is invalid');
  }
  if (facts.requestedAtEpochMs === null || facts.purgeAfterEpochMs === null) {
    if (facts.requestedAtEpochMs !== null || facts.purgeAfterEpochMs !== null) {
      throw new TypeError('RTC RTT lifecycle facts must be jointly absent');
    }
    return;
  }
  if (!Number.isSafeInteger(facts.requestedAtEpochMs) || facts.requestedAtEpochMs < 0) {
    throw new TypeError('RTC RTT requested-at lifecycle fact is invalid');
  }
  if (
    !Number.isSafeInteger(facts.purgeAfterEpochMs) ||
    facts.purgeAfterEpochMs <= facts.requestedAtEpochMs
  ) {
    throw new TypeError('RTC RTT purge-after lifecycle fact is invalid');
  }
}

export function assertReceiptOnlyRttInputs(
  command: RtcRttMutationCommand,
  facts: RtcRttMutationFacts,
): void {
  if (
    command.candidateGroups !== null ||
    command.overlaySnapshotsByGroupKey !== null ||
    command.degreeLimit !== null ||
    facts.requestedAtEpochMs !== null ||
    facts.purgeAfterEpochMs !== null
  ) {
    throw new TypeError('RTC RTT receipt replay must not include authority or lifecycle facts');
  }
}

export function requireRttAuthority(
  command: RtcRttMutationCommand,
  facts: RtcRttMutationFacts,
): Readonly<{
  command: RtcRttStableRequest &
    Readonly<{
      candidateGroups: readonly GroupSnapshot[];
      overlaySnapshotsByGroupKey: ReadonlyMap<string, RallarOverlayTopologySnapshot>;
      degreeLimit: number;
    }>;
  facts: RtcRttMutationLifecycleFacts & Readonly<{ commandHash: string }>;
}> {
  if (
    command.candidateGroups === null ||
    command.overlaySnapshotsByGroupKey === null ||
    command.degreeLimit === null ||
    facts.requestedAtEpochMs === null ||
    facts.purgeAfterEpochMs === null
  ) {
    throw new TypeError('RTC RTT receipt miss requires authority and lifecycle facts');
  }
  return {
    command: command as RtcRttStableRequest &
      Readonly<{
        candidateGroups: readonly GroupSnapshot[];
        overlaySnapshotsByGroupKey: ReadonlyMap<string, RallarOverlayTopologySnapshot>;
        degreeLimit: number;
      }>,
    facts: facts as RtcRttMutationLifecycleFacts & Readonly<{ commandHash: string }>,
  };
}
