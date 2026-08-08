import { toRtcTopologyEntryResourceId } from '../../../services/rtc-topology-outbox-entry.ts';
import { computeTopologyConfigMutation } from './compute-topology-config-mutation.ts';
import type {
  GroupTopologyConfigMutationComputed,
  TopologyConfigMutationInput,
} from './group-topology-config-mutation-contracts.ts';
import { requireTopologyConfigRequestId } from './validate-topology-config-mutation-input.ts';
// prettier-ignore
import {
  validateGroupTopologyConfigMutationRecord,
} from './validate-topology-config-records.ts';

export interface ValidateTopologyConfigMutationInput extends TopologyConfigMutationInput {
  readonly computed: GroupTopologyConfigMutationComputed;
}

export function validateTopologyConfigMutation(
  topologyValidation: ValidateTopologyConfigMutationInput,
): void {
  const computed = topologyValidation.computed;
  const canonical = computeTopologyConfigMutation(topologyValidation);
  if (JSON.stringify(computed) !== JSON.stringify(canonical)) {
    const operation = topologyValidation.command.operation;
    throw new TypeError(
      `Topology config ${operation} mutation differs from its canonical deterministic projection`,
    );
  }
  if (computed.outcome === 'write' || computed.outcome === 'claim') {
    validateWrittenOrClaimedTopologyConfigMutation({ ...topologyValidation, computed });
  }
  if (
    computed.outcome === 'write' &&
    computed.receipt.outboxId !== toRtcTopologyEntryResourceId(computed.outbox)
  ) {
    throw new TypeError('Topology config receipt outbox differs from intent');
  }
}

function validateWrittenOrClaimedTopologyConfigMutation(
  topologyValidation: ValidateTopologyConfigMutationInput &
    Readonly<{
      computed: Extract<GroupTopologyConfigMutationComputed, { outcome: 'write' | 'claim' }>;
    }>,
): void {
  if (topologyValidation.computed.receipt.commandHash !== topologyValidation.facts.commandHash) {
    throw new TypeError('Topology config receipt hash differs from facts');
  }
  if (topologyValidation.computed.idempotency !== null) {
    validateGroupTopologyConfigMutationRecord(topologyValidation.computed.idempotency, {
      groupRef: topologyValidation.command.aggregateRef,
      requestId: requireTopologyConfigRequestId(topologyValidation.command),
    });
  }
}
