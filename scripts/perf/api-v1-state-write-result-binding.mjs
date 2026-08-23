export function isValidPersistedResult(entry, command, binding) {
    if (
        !isObject(entry) || !isObject(command) || typeof entry.commandType !== 'string' ||
        !isObject(entry.durableResult) || !isObject(binding)
    ) {
        return false;
    }
    const result = entry.durableResult;
    if (command.kind === 'profile-instance') {
        return entry.commandType.startsWith('CLIENT_') && hasExactKeys(result, ['status', 'result']) &&
            result.status === 'ok' && hasExactKeys(result.result, ['snapshot', 'event']) &&
            isObject(result.result.snapshot) &&
            matchesStateResult(result.result, binding, 'principal');
    }
    if (command.kind.startsWith('presence-')) {
        return entry.commandType.startsWith('GROUP_PRESENCE_') &&
            result.commandId === binding.receiptId && typeof result.outcome === 'string' &&
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
            matchesTopologyResult(entry.commandType, result, binding);
    }
    return entry.commandType.startsWith('GROUP_') &&
        hasExactKeys(result, ['status', 'result']) && ['ok', 'created'].includes(result.status) &&
        hasExactKeys(result.result, ['snapshot', 'event']) && isObject(result.result.snapshot) &&
        matchesStateResult(result.result, binding, 'group');
}

export function validateReceiptResultBindings(receipt, command, path, index, errors) {
    const bindings = receipt?.resultBindings;
    const expectedOperations = command?.kind === 'profile-instance'
        ? ['profile', 'instance']
        : ['command'];
    if (
        !isDenseArray(bindings) || !sameStringArray(
            bindings.map((binding) => binding?.operationId).toSorted(),
            expectedOperations.toSorted()
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
                'outcome',
                'attemptCount',
                'outboxIds',
                'aggregateRef',
                'stateRevision',
                'causalRevision',
                'snapshotVersion',
                'acceptedVersion',
                'operation',
                'target',
                'acceptedStorageRevision',
                'acceptedCreatedAtEpochMs',
                'acceptedUpdatedAtEpochMs',
                'acceptedExpiresAtEpochMs',
                'acceptedConfig',
                'acceptedCausalRevision',
                'eventId'
            ]) || typeof binding.receiptId !== 'string' || binding.receiptId.length === 0 ||
            !isValidReceiptIdentity(command, binding) ||
            !/^sha256:[0-9a-f]{64}$/.test(binding.commandHash) ||
            typeof binding.outcome !== 'string' || binding.outcome.length === 0 ||
            !Number.isSafeInteger(binding.attemptCount) || binding.attemptCount < 1 ||
            !isDenseStringArray(binding.outboxIds) ||
            new Set(binding.outboxIds).size !== binding.outboxIds.length ||
            !isAggregateRef(binding.aggregateRef, command?.kind === 'profile-instance') ||
            !nullableNonNegativeInteger(binding.stateRevision) ||
            !validAuthorityRevisionBinding(binding, command?.kind) ||
            !nullableNonNegativeInteger(binding.snapshotVersion) ||
            !nullableNonNegativeInteger(binding.acceptedVersion) ||
            !validTopologyBinding(binding, command?.kind === 'topology-source') ||
            !(binding.eventId === null || typeof binding.eventId === 'string') ||
            !receipt.receiptIds.includes(binding.receiptId)
        ) {
            errors.push(`${path}.durableEvidence.receipts[${index}] has malformed result binding`);
        }
    }
}

function validTopologyBinding(binding, topology) {
    if (!topology) {
        return [
            'acceptedVersion',
            'operation',
            'target',
            'acceptedStorageRevision',
            'acceptedCreatedAtEpochMs',
            'acceptedUpdatedAtEpochMs',
            'acceptedExpiresAtEpochMs',
            'acceptedConfig',
            'acceptedCausalRevision'
        ].every((field) => binding[field] === null);
    }
    const put = binding.operation === 'putConfig' || binding.operation === 'putOverride';
    const override = binding.operation === 'putOverride' || binding.operation === 'deleteOverride';
    const validBase = ['putConfig', 'deleteConfig', 'putOverride', 'deleteOverride'].includes(
        binding.operation
    ) && binding.target === (override ? 'override' : 'config') &&
        ['applied', 'no-op'].includes(binding.outcome) && binding.eventId === null &&
        Number.isSafeInteger(binding.acceptedVersion) && binding.acceptedVersion >= 0 &&
        nullableNonNegativeInteger(binding.acceptedStorageRevision) &&
        nullableNonNegativeInteger(binding.acceptedCreatedAtEpochMs) &&
        nullableNonNegativeInteger(binding.acceptedUpdatedAtEpochMs) &&
        nullableNonNegativeInteger(binding.acceptedExpiresAtEpochMs) &&
        (binding.acceptedConfig === null || validTopologyConfig(binding.acceptedConfig)) &&
        (binding.acceptedCausalRevision === null ||
            validAcceptedCausalRevision(binding.acceptedCausalRevision));
    if (!validBase) {
        return false;
    }
    const causal = binding.acceptedCausalRevision;
    const validCausal = causal !== null && validAcceptedCausalRevision(causal);
    const expectedOutboxId = !validCausal ? null : [
        binding.receiptId,
        'rtc-topology-recompute',
        'group-revision',
        `group=${causal.causalRevision.groupRevision};presence=${causal.causalRevision.presenceRevision}`
    ].join(':');
    const effectMatches = binding.outcome === 'applied'
        ? binding.acceptedVersion > 0 && binding.acceptedStorageRevision !== null &&
            validCausal && binding.outboxIds.length === 1 &&
            binding.outboxIds[0] === expectedOutboxId
        : causal === null && binding.outboxIds.length === 0 &&
            (binding.acceptedVersion !== 0 || binding.acceptedStorageRevision === null);
    if (!effectMatches) {
        return false;
    }
    if (!put) {
        return binding.acceptedConfig === null && binding.acceptedCreatedAtEpochMs === null &&
            binding.acceptedUpdatedAtEpochMs === null && binding.acceptedExpiresAtEpochMs === null;
    }
    return binding.outcome === 'applied' && binding.acceptedStorageRevision !== null &&
        binding.acceptedCreatedAtEpochMs !== null && binding.acceptedUpdatedAtEpochMs !== null &&
        binding.acceptedCreatedAtEpochMs <= binding.acceptedUpdatedAtEpochMs &&
        validTopologyConfig(binding.acceptedConfig) && validAcceptedCausalRevision(causal) &&
        causal.snapshotVersion === binding.snapshotVersion &&
        (override
            ? binding.acceptedExpiresAtEpochMs > binding.acceptedUpdatedAtEpochMs
            : binding.acceptedExpiresAtEpochMs === null);
}

function expectedReceiptId(command, operationId) {
    return command.kind === 'profile-instance'
        ? `${command.commandId}-${operationId}`
        : command.commandId;
}

function isValidReceiptIdentity(command, binding) {
    const requestId = expectedReceiptId(command, binding.operationId);
    if (binding.requestId !== requestId) {
        return false;
    }
    return command.kind === 'profile-instance' || command.kind === 'topology-source'
        ? binding.receiptId === requestId
        : /^group-app-inbox:[0-9a-f]{64}$/.test(binding.receiptId);
}

function matchesStateResult(stateResult, binding, aggregateField) {
    const snapshot = stateResult.snapshot;
    const event = stateResult.event;
    if (!isObject(snapshot)) {
        return false;
    }
    const revisionMatches = aggregateField === 'principal'
        ? snapshot.stateRevision === binding.stateRevision
        : sameJson(snapshot.causalRevision, binding.causalRevision);
    if (
        !sameAggregateRef(snapshot[aggregateField], binding.aggregateRef) ||
        !revisionMatches ||
        snapshot[aggregateField].snapshotVersion !== binding.snapshotVersion
    ) {
        return false;
    }
    if (binding.eventId === null) {
        return event === null;
    }
    return isObject(event) && event.eventId === binding.eventId &&
        event.requestId === binding.requestId && event.snapshotVersion === binding.snapshotVersion &&
        sameAggregateRef(event, binding.aggregateRef);
}

function matchesEmbeddedReceipt(receipt, binding) {
    return receipt.commandId === binding.receiptId && receipt.requestId === binding.requestId &&
        receipt.commandHash === binding.commandHash &&
        receipt.outcome === binding.outcome && receipt.attemptCount === binding.attemptCount &&
        sameStringArray(receipt.outboxIds, binding.outboxIds) &&
        sameAggregateRef(receipt.aggregateRef, binding.aggregateRef) &&
        sameJson(receipt.causalRevision, binding.causalRevision) &&
        receipt.snapshotVersion === binding.snapshotVersion && receipt.eventId === binding.eventId;
}

function matchesTopologyResult(commandType, result, binding) {
    const shape = {
        TOPOLOGY_CONFIG_PUT: ['putConfig', 'config'],
        TOPOLOGY_CONFIG_DELETE: ['deleteConfig', null],
        TOPOLOGY_OVERRIDE_PUT: ['putOverride', 'override'],
        TOPOLOGY_OVERRIDE_DELETE: ['deleteOverride', null]
    }[commandType];
    if (
        !shape || binding.operation !== shape[0] ||
        binding.target !== (commandType.includes('_OVERRIDE_') ? 'override' : 'config') ||
        !hasExactKeys(result, shape[1] ? ['receipt', shape[1]] : ['receipt']) ||
        !hasExactKeys(result.receipt, TOPOLOGY_RECEIPT_KEYS) ||
        !matchesTopologyReceipt(result.receipt, binding)
    ) {
        return false;
    }
    return shape[1] === null || matchesStoredTopology(result[shape[1]], binding, shape[1]);
}

const TOPOLOGY_RECEIPT_KEYS = [
    'commandId',
    'requestId',
    'commandHash',
    'operation',
    'outcome',
    'attemptCount',
    'groupRef',
    'target',
    'acceptedVersion',
    'acceptedStorageRevision',
    'acceptedCreatedAtEpochMs',
    'acceptedUpdatedAtEpochMs',
    'acceptedExpiresAtEpochMs',
    'acceptedConfig',
    'acceptedCausalRevision',
    'eventId',
    'outboxIds'
];

function matchesTopologyReceipt(receipt, binding) {
    return receipt.commandId === binding.receiptId && receipt.requestId === binding.requestId &&
        receipt.commandHash === binding.commandHash &&
        receipt.outcome === binding.outcome && receipt.attemptCount === binding.attemptCount &&
        sameStringArray(receipt.outboxIds, binding.outboxIds) &&
        sameAggregateRef(receipt.groupRef, binding.aggregateRef) &&
        receipt.operation === binding.operation && receipt.target === binding.target &&
        receipt.acceptedVersion === binding.acceptedVersion &&
        receipt.acceptedStorageRevision === binding.acceptedStorageRevision &&
        receipt.acceptedCreatedAtEpochMs === binding.acceptedCreatedAtEpochMs &&
        receipt.acceptedUpdatedAtEpochMs === binding.acceptedUpdatedAtEpochMs &&
        receipt.acceptedExpiresAtEpochMs === binding.acceptedExpiresAtEpochMs &&
        sameJson(receipt.acceptedConfig, binding.acceptedConfig) &&
        sameJson(receipt.acceptedCausalRevision, binding.acceptedCausalRevision) &&
        receipt.eventId === binding.eventId &&
        (binding.snapshotVersion === null ||
            receipt.acceptedCausalRevision?.snapshotVersion === binding.snapshotVersion);
}

function matchesStoredTopology(stored, binding, target) {
    const keys = [
        'groupRef',
        'config',
        'version',
        'createdAtEpochMs',
        'updatedAtEpochMs',
        'updatedByPrincipalId',
        'requestId',
        ...(target === 'override' ? ['expiresAtEpochMs'] : [])
    ];
    return isObject(stored) && hasExactKeys(stored, keys) &&
        sameAggregateRef(stored.groupRef, binding.aggregateRef) &&
        sameJson(stored.config, binding.acceptedConfig) &&
        stored.version === binding.acceptedVersion &&
        stored.createdAtEpochMs === binding.acceptedCreatedAtEpochMs &&
        stored.updatedAtEpochMs === binding.acceptedUpdatedAtEpochMs &&
        stored.requestId === binding.requestId &&
        typeof stored.updatedByPrincipalId === 'string' && stored.updatedByPrincipalId.length > 0 &&
        (target !== 'override' || stored.expiresAtEpochMs === binding.acceptedExpiresAtEpochMs);
}

function validTopologyConfig(value) {
    const numericFields = ['degreeLimit', 'treeMinSize', 'meshMinSize', 'meshParamK'];
    return hasExactKeys(value, [
        'topologyKind',
        'degreeLimit',
        'treeMinSize',
        'meshMinSize',
        'meshParamK'
    ]) && ['auto', 'star', 'tree', 'mesh'].includes(value.topologyKind) &&
        numericFields.every((field) => Number.isSafeInteger(value[field]) && value[field] > 0) &&
        value.meshMinSize >= value.treeMinSize && value.meshParamK <= value.degreeLimit;
}

function validAcceptedCausalRevision(value) {
    if (
        !hasExactKeys(value, [
            'causalRevision',
            'snapshotVersion',
            'metadataVersion',
            'rosterVersion',
            'presenceVersion'
        ]) || !isObject(value.causalRevision) || !hasExactKeys(
            value.causalRevision,
            ['groupRevision', 'presenceRevision']
        )
    ) {
        return false;
    }
    return [
        value.snapshotVersion,
        value.metadataVersion,
        value.rosterVersion,
        value.presenceVersion,
        value.causalRevision.groupRevision,
        value.causalRevision.presenceRevision
    ].every((entry) => Number.isSafeInteger(entry) && entry >= 0);
}

function validAuthorityRevisionBinding(binding, commandKind) {
    if (commandKind === 'profile-instance') {
        return Number.isSafeInteger(binding.stateRevision) && binding.stateRevision >= 0 &&
            binding.causalRevision === null;
    }
    if (commandKind === 'topology-source') {
        return binding.stateRevision === null && binding.causalRevision === null;
    }
    return binding.stateRevision === null && validGroupCausalRevision(binding.causalRevision);
}

function validGroupCausalRevision(value) {
    return isObject(value) && hasExactKeys(value, ['groupRevision', 'presenceRevision']) &&
        [value.groupRevision, value.presenceRevision].every(
            (entry) => Number.isSafeInteger(entry) && entry >= 0
        );
}

function sameJson(left, right) {
    if (Object.is(left, right)) {
        return true;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
            left.every((entry, index) => sameJson(entry, right[index]));
    }
    if (!isObject(left) || !isObject(right)) {
        return false;
    }
    const keys = Object.keys(left).toSorted();
    return sameStringArray(keys, Object.keys(right).toSorted()) &&
        keys.every((key) => sameJson(left[key], right[key]));
}

function isAggregateRef(value, client) {
    if (
        !isObject(value) || typeof value.applicationId !== 'string' ||
        typeof value.workspaceId !== 'string'
    ) {
        return false;
    }
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
