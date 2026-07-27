export function isValidPersistedResult(entry, command, binding) {
  if (
    !isObject(entry) || !isObject(command) || typeof entry.commandType !== 'string' ||
    !isObject(entry.durableResult) || !isObject(binding)
  ) return false;
  const result = entry.durableResult;
  if (command.kind === 'profile-instance') {
    return entry.commandType.startsWith('CLIENT_') && hasExactKeys(result, ['status', 'result']) &&
      hasExactKeys(result.result, ['right']) && result.status === 'ok' &&
      isObject(result.result?.right) && isObject(result.result.right.snapshot) &&
      hasExactKeys(result.result.right, ['snapshot', 'event']) &&
      matchesStateResult(result.result.right, binding, 'principal');
  }
  if (command.kind.startsWith('presence-')) {
    return entry.commandType.startsWith('GROUP_PRESENCE_') &&
      result.commandId === command.commandId && typeof result.outcome === 'string' &&
      Number.isSafeInteger(result.attemptCount) && isDenseStringArray(result.outboxIds) &&
      new Set(result.outboxIds).size === result.outboxIds.length &&
      matchesEmbeddedReceipt(result, binding);
  }
  if (command.kind === 'topology-source') {
    const receipt = result.receipt;
    return entry.commandType.startsWith('TOPOLOGY_') && isObject(receipt) &&
      receipt.commandId === command.commandId && typeof receipt.outcome === 'string' &&
      Number.isSafeInteger(receipt.attemptCount) && isDenseStringArray(receipt.outboxIds) &&
      new Set(receipt.outboxIds).size === receipt.outboxIds.length &&
      matchesTopologyReceipt(receipt, binding);
  }
  return entry.commandType.startsWith('GROUP_') &&
    hasExactKeys(result, ['status', 'result']) && hasExactKeys(result.result, ['right']) &&
    ['ok', 'created'].includes(result.status) && isObject(result.result?.right) &&
    hasExactKeys(result.result.right, ['snapshot', 'event']) &&
    isObject(result.result.right.snapshot) &&
    matchesStateResult(result.result.right, binding, 'group');
}

export function validateReceiptResultBindings(receipt, command, path, index, errors) {
  const bindings = receipt?.resultBindings;
  const expectedOperations = command?.kind === 'profile-instance'
    ? ['profile', 'instance']
    : ['command'];
  if (
    !isDenseArray(bindings) || !sameStringArray(
      bindings.map((binding) => binding?.operationId).toSorted(),
      expectedOperations.toSorted(),
    )
  ) {
    errors.push(`${path}.durableEvidence.receipts[${index}] result bindings must match operations`);
    return;
  }
  for (const binding of bindings) {
    if (
      !hasExactKeys(binding, [
        'operationId',
        'receiptId',
        'requestId',
        'commandHash',
        'aggregateRef',
        'stateRevision',
        'snapshotVersion',
        'acceptedVersion',
        'eventId',
      ]) || typeof binding.receiptId !== 'string' || binding.receiptId.length === 0 ||
      binding.receiptId !== expectedReceiptId(command, binding.operationId) ||
      binding.requestId !== binding.receiptId ||
      !/^sha256:[0-9a-f]{64}$/.test(binding.commandHash) ||
      !isAggregateRef(binding.aggregateRef, command?.kind === 'profile-instance') ||
      !nullableNonNegativeInteger(binding.stateRevision) ||
      !nullableNonNegativeInteger(binding.snapshotVersion) ||
      !nullableNonNegativeInteger(binding.acceptedVersion) ||
      !(binding.eventId === null || typeof binding.eventId === 'string') ||
      !receipt.receiptIds.includes(binding.receiptId)
    ) {
      errors.push(`${path}.durableEvidence.receipts[${index}] has malformed result binding`);
    }
  }
}

function expectedReceiptId(command, operationId) {
  return command.kind === 'profile-instance'
    ? `${command.commandId}-${operationId}`
    : command.commandId;
}

function matchesStateResult(right, binding, aggregateField) {
  const snapshot = right.snapshot;
  const event = right.event;
  if (
    !isObject(snapshot) || !sameAggregateRef(snapshot[aggregateField], binding.aggregateRef) ||
    snapshot.stateRevision !== binding.stateRevision ||
    snapshot[aggregateField].snapshotVersion !== binding.snapshotVersion
  ) return false;
  if (binding.eventId === null) return event === null;
  return isObject(event) && event.eventId === binding.eventId &&
    event.requestId === binding.requestId && event.snapshotVersion === binding.snapshotVersion &&
    sameAggregateRef(event, binding.aggregateRef);
}

function matchesEmbeddedReceipt(receipt, binding) {
  return receipt.commandId === binding.receiptId && receipt.requestId === binding.requestId &&
    receipt.commandHash === binding.commandHash &&
    sameAggregateRef(receipt.aggregateRef, binding.aggregateRef) &&
    receipt.stateRevision === binding.stateRevision &&
    receipt.snapshotVersion === binding.snapshotVersion && receipt.eventId === binding.eventId;
}

function matchesTopologyReceipt(receipt, binding) {
  return receipt.commandId === binding.receiptId && receipt.requestId === binding.requestId &&
    receipt.commandHash === binding.commandHash &&
    sameAggregateRef(receipt.groupRef, binding.aggregateRef) &&
    receipt.acceptedVersion === binding.acceptedVersion && receipt.eventId === binding.eventId &&
    (binding.stateRevision === null ||
      receipt.acceptedCausalRevision?.stateRevision === binding.stateRevision) &&
    (binding.snapshotVersion === null ||
      receipt.acceptedCausalRevision?.snapshotVersion === binding.snapshotVersion);
}

function isAggregateRef(value, client) {
  if (
    !isObject(value) || typeof value.applicationId !== 'string' ||
    typeof value.workspaceId !== 'string'
  ) return false;
  return client
    ? hasExactKeys(value, ['applicationId', 'workspaceId', 'principalId']) &&
      typeof value.principalId === 'string'
    : hasExactKeys(value, ['applicationId', 'workspaceId', 'groupId']) &&
      typeof value.groupId === 'string';
}

function sameAggregateRef(value, expected) {
  return isObject(value) && Object.keys(expected).every((key) => value[key] === expected[key]);
}

function nullableNonNegativeInteger(value) {
  return value === null || Number.isSafeInteger(value) && value >= 0;
}

function isDenseArray(value) {
  return Array.isArray(value) && Object.keys(value).length === value.length;
}

function isDenseStringArray(value) {
  return isDenseArray(value) && value.every((entry) => typeof entry === 'string');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isObject(value) && sameStringArray(Object.keys(value).toSorted(), keys.toSorted());
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
