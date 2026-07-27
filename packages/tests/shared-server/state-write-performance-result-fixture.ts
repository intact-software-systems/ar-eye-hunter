import {
  PRODUCTION_STATE_WRITE_MUTATION_CONTRACT,
} from '../../../scripts/perf/compare-api-v1-state-write-results.mjs';

export function binding(command: any, operationId: string): any {
  const receiptId = command.kind === 'profile-instance'
    ? `${command.commandId}-${operationId}`
    : command.commandId;
  const aggregateRef = command.kind === 'profile-instance'
    ? { applicationId: 'app', workspaceId: 'workspace', principalId: command.commandId }
    : { applicationId: 'app', workspaceId: 'workspace', groupId: command.commandId };
  return {
    operationId,
    receiptId,
    requestId: receiptId,
    commandHash: `sha256:${'a'.repeat(64)}`,
    aggregateRef,
    stateRevision: 1,
    snapshotVersion: 1,
    acceptedVersion: command.kind === 'topology-source' ? 1 : null,
    eventId: command.kind === 'topology-source' ? null : `${receiptId}:event`,
  };
}

export function durableResult(command: any, operationId: string): any {
  const authoritative = binding(command, operationId);
  const outboxIds = PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind]
    .map((_, index) => `${command.commandId}:effect:${index}`);
  if (command.kind === 'topology-source') {
    return {
      receipt: {
        commandId: authoritative.receiptId,
        requestId: authoritative.requestId,
        commandHash: authoritative.commandHash,
        groupRef: authoritative.aggregateRef,
        acceptedVersion: authoritative.acceptedVersion,
        acceptedCausalRevision: {
          stateRevision: authoritative.stateRevision,
          snapshotVersion: authoritative.snapshotVersion,
        },
        eventId: authoritative.eventId,
        outcome: 'applied',
        attemptCount: 1,
        outboxIds,
      },
    };
  }
  if (command.kind.startsWith('presence-')) {
    return {
      commandId: authoritative.receiptId,
      requestId: authoritative.requestId,
      commandHash: authoritative.commandHash,
      aggregateRef: authoritative.aggregateRef,
      stateRevision: authoritative.stateRevision,
      snapshotVersion: authoritative.snapshotVersion,
      eventId: authoritative.eventId,
      outcome: 'applied',
      attemptCount: 1,
      outboxIds,
    };
  }
  const aggregateField = command.kind === 'profile-instance' ? 'principal' : 'group';
  return {
    status: 'ok',
    result: {
      right: {
        snapshot: {
          stateRevision: authoritative.stateRevision,
          [aggregateField]: {
            ...authoritative.aggregateRef,
            snapshotVersion: authoritative.snapshotVersion,
          },
        },
        event: {
          ...authoritative.aggregateRef,
          eventId: authoritative.eventId,
          requestId: authoritative.requestId,
          snapshotVersion: authoritative.snapshotVersion,
        },
      },
    },
  };
}

export function swapCompleteDurableResults(candidate: any, prefix: string): void {
  const candidates = candidate.workloads[0].samples[0].durableEvidence.appInbox.filter(
    (entry: any) => entry.commandType.startsWith(prefix) && entry.durableResult.status,
  );
  const [first, second] = candidates.filter((entry: any) =>
    entry.operationId === candidates[0].operationId
  );
  [first.durableResult, second.durableResult] = [second.durableResult, first.durableResult];
}
