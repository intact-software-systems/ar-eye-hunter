import type { AuthoritativeTopologyReceipt } from './api-v1-state-write-result-evidence.ts';

type RecordValue = Record<string, unknown>;

export function validateTopologyMutationResultPayload(
  commandType: string,
  result: RecordValue,
  authoritative?: AuthoritativeTopologyReceipt,
): string | undefined {
  const receipt = record(result.receipt);
  if (!receipt) return 'missing-topology-receipt';
  const operation = operationByType[commandType];
  const target = commandType.includes('_OVERRIDE_') ? 'override' : 'config';
  if (!operation || receipt.operation !== operation || receipt.target !== target) {
    return 'mismatched-topology-operation';
  }
  const isPut = commandType.endsWith('_PUT');
  const siblingName = target;
  if (!exactKeys(result, isPut ? ['receipt', siblingName] : ['receipt'])) {
    return 'malformed-topology-result-wrapper';
  }
  if (isPut) {
    const sibling = record(result[siblingName]);
    if (!sibling || !validateStoredTopology(sibling, receipt, target)) {
      return 'mismatched-topology-result-payload';
    }
  }
  if (authoritative && !matchesAuthoritative(receipt, authoritative)) {
    return 'mismatched-topology-authoritative-payload';
  }
  return undefined;
}

const operationByType: Readonly<Record<string, string>> = {
  TOPOLOGY_CONFIG_PUT: 'putConfig',
  TOPOLOGY_CONFIG_DELETE: 'deleteConfig',
  TOPOLOGY_OVERRIDE_PUT: 'putOverride',
  TOPOLOGY_OVERRIDE_DELETE: 'deleteOverride',
};

function validateStoredTopology(
  stored: RecordValue,
  receipt: RecordValue,
  target: string,
): boolean {
  const keys =
    target === 'override'
      ? [
          'groupRef',
          'config',
          'version',
          'createdAtEpochMs',
          'updatedAtEpochMs',
          'updatedByPrincipalId',
          'requestId',
          'expiresAtEpochMs',
        ]
      : [
          'groupRef',
          'config',
          'version',
          'createdAtEpochMs',
          'updatedAtEpochMs',
          'updatedByPrincipalId',
          'requestId',
        ];
  return (
    exactKeys(stored, keys) &&
    sameGroupRef(stored.groupRef, receipt.groupRef) &&
    stored.version === receipt.acceptedVersion &&
    stored.createdAtEpochMs === receipt.acceptedCreatedAtEpochMs &&
    stored.updatedAtEpochMs === receipt.acceptedUpdatedAtEpochMs &&
    stored.requestId === receipt.requestId &&
    sameConfig(stored.config, receipt.acceptedConfig) &&
    (target !== 'override' || stored.expiresAtEpochMs === receipt.acceptedExpiresAtEpochMs) &&
    typeof stored.updatedByPrincipalId === 'string' &&
    stored.updatedByPrincipalId.length > 0
  );
}

function matchesAuthoritative(
  receipt: RecordValue,
  authoritative: AuthoritativeTopologyReceipt,
): boolean {
  return (
    receipt.operation === authoritative.operation &&
    receipt.target === authoritative.target &&
    sameGroupRef(receipt.groupRef, authoritative.groupRef) &&
    receipt.acceptedVersion === authoritative.acceptedVersion &&
    receipt.acceptedStorageRevision === authoritative.acceptedStorageRevision &&
    receipt.acceptedCreatedAtEpochMs === authoritative.acceptedCreatedAtEpochMs &&
    receipt.acceptedUpdatedAtEpochMs === authoritative.acceptedUpdatedAtEpochMs &&
    receipt.acceptedExpiresAtEpochMs === authoritative.acceptedExpiresAtEpochMs &&
    sameConfig(receipt.acceptedConfig, authoritative.acceptedConfig)
  );
}

function sameGroupRef(left: unknown, right: unknown): boolean {
  const a = record(left);
  const b = record(right);
  return Boolean(
    a &&
    b &&
    exactKeys(a, ['applicationId', 'workspaceId', 'groupId']) &&
    exactKeys(b, ['applicationId', 'workspaceId', 'groupId']) &&
    a.applicationId === b.applicationId &&
    a.workspaceId === b.workspaceId &&
    a.groupId === b.groupId,
  );
}

function sameConfig(left: unknown, right: unknown): boolean {
  const a = record(left);
  const b = record(right);
  const keys = ['topologyKind', 'degreeLimit', 'treeMinSize', 'meshMinSize', 'meshParamK'];
  return (
    (left === null && right === null) ||
    Boolean(
      a && b && exactKeys(a, keys) && exactKeys(b, keys) && keys.every((key) => a[key] === b[key]),
    )
  );
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function exactKeys(value: RecordValue, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify([...keys].toSorted());
}
