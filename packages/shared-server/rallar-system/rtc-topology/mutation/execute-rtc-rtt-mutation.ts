import type { PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';

import { RtcRttRepository } from '../persistence/rtc-rtt-repository.ts';
import { hashCanonicalCommand } from '../../services/canonical-command-hash.ts';
import { computeRtcRttMutation } from './compute-rtc-rtt-mutation.ts';
import type {
  RtcRttMutationCommand,
  RtcRttMutationComputed,
  RtcRttMutationFacts,
  RtcRttMutationLifecycleFacts,
  RtcRttStableRequest,
} from './rtc-rtt-mutation-contracts.ts';
import { readRtcRttMutation } from './read-rtc-rtt-mutation.ts';
import { validateRtcRttMutation } from './validate-rtc-rtt-mutation.ts';
import { writeRtcRttMutation } from './write-rtc-rtt-mutation.ts';

export type ExecuteRtcRttMutationResult = Readonly<{
  computed: RtcRttMutationComputed;
  updated: boolean;
}>;

export type ExecuteRtcRttMutationInput = Readonly<{
  repository: RtcRttRepository;
  transaction: PSqlTransactionSql;
  readFacts: () => RtcRttMutationLifecycleFacts | Promise<RtcRttMutationLifecycleFacts>;
  request: RtcRttStableRequest;
  readCommand: () => RtcRttMutationCommand | Promise<RtcRttMutationCommand>;
  attemptCount: number;
}>;

export async function executeRtcRttMutation(
  input: ExecuteRtcRttMutationInput,
): Promise<ExecuteRtcRttMutationResult> {
  const stableRequest = input.request;
  const commandHash = await hashCanonicalCommand(stableRequest);
  const read = await readRtcRttMutation(input.repository, stableRequest);
  let command: RtcRttMutationCommand;
  let facts: RtcRttMutationFacts;
  if (read.receipt) {
    command = {
      ...stableRequest,
      candidateGroups: null,
      overlaySnapshotsByGroupKey: null,
      degreeLimit: null,
    };
    facts = {
      commandHash,
      attemptCount: input.attemptCount,
      requestedAtEpochMs: null,
      purgeAfterEpochMs: null,
    };
  } else {
    command = await input.readCommand();
    facts = {
      ...(await input.readFacts()),
      commandHash,
      attemptCount: input.attemptCount,
    };
  }
  const computed = computeRtcRttMutation({ command, read, facts });
  validateRtcRttMutation({ command, read, facts, computed });
  if (computed.outcome !== 'write') return { computed, updated: false };
  if (facts.requestedAtEpochMs === null || facts.purgeAfterEpochMs === null) {
    throw new TypeError('RTC RTT write is missing lifecycle facts');
  }
  await writeRtcRttMutation(
    input.transaction,
    {
      ttlMs: facts.purgeAfterEpochMs - facts.requestedAtEpochMs,
      now: () => facts.requestedAtEpochMs,
    },
    computed,
  );
  return { computed, updated: true };
}
