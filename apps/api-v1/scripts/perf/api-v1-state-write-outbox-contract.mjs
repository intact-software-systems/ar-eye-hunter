/** Logical minimum effects; receipts enumerate every physical snapshot carrier. */
export const PRODUCTION_STATE_WRITE_MUTATION_CONTRACT = Object.freeze({
    'profile-instance': Object.freeze([
        'principal-state:snapshot',
        'principal-state:event',
        'principal-state:snapshot',
        'principal-state:event'
    ]),
    membership: Object.freeze(['group-presence-summary']),
    'presence-connect': Object.freeze(['group-presence-summary']),
    'presence-heartbeat': Object.freeze(['group-presence-summary']),
    'presence-disconnect': Object.freeze(['group-presence-summary']),
    config: Object.freeze(['group-presence-summary']),
    'topology-source': Object.freeze(['rtc-topology-recompute'])
});

/** Physical carrier multiplicity comes from the durable operation receipts. */
export function matchesStateWriteOutboxContract(command, receipt, effects) {
    const expected = Object.hasOwn(PRODUCTION_STATE_WRITE_MUTATION_CONTRACT, command?.kind)
        ? PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind]
        : undefined;
    if (
        !expected || !receipt || !Array.isArray(receipt.resultBindings) ||
        !Array.isArray(effects)
    ) {
        return false;
    }
    const operations = command.kind === 'profile-instance'
        ? ['profile', 'instance']
        : ['command'];
    const bindings = receipt.resultBindings;
    if (
        !sameIdentities(
            bindings.map((binding) => binding?.operationId),
            operations
        ) ||
        !sameIdentities(
            bindings.map((binding) => binding?.receiptId),
            receipt.receiptIds
        ) ||
        !sameIdentities(
            bindings.flatMap((binding) => binding?.outboxIds ?? []),
            receipt.outboxIds
        ) ||
        !sameIdentities(
            effects.map((effect) => effect?.effectId),
            receipt.outboxIds
        ) ||
        !['physical-resource-id', 'logical-msg-id'].includes(receipt.identityKind)
    ) {
        return false;
    }
    if (
        effects.some((effect) =>
            effect.commandId !== command.commandId || effect.effectId !== (
                    receipt.identityKind === 'physical-resource-id'
                        ? effect.resourceId
                        : effect.outboxId
                )
        )
    ) {
        return false;
    }
    return bindings.every((binding) => {
        const owned = effects.filter((effect) => binding.outboxIds.includes(effect.effectId));
        const kinds = owned.map((effect) => effect.effectKind);
        if (command.kind === 'profile-instance') {
            const eventCount = kinds.filter((kind) => kind === 'principal-state:event').length;
            const snapshotCount = kinds.filter((kind) => kind === 'principal-state:snapshot').length;
            return eventCount === 1 && snapshotCount >= 1 && eventCount + snapshotCount === kinds.length;
        }
        return sameIdentities(kinds, expected);
    });
}

export function requiredStateWriteOutboxCount(commands, receipts) {
    const byCommand = new Map(
        receipts.map((receipt) => [receipt?.commandId, receipt])
    );
    return commands.filter((command) => command.status === 'accepted').reduce(
        (total, command) => {
            const minimum = PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind]?.length ?? 0;
            return total +
                Math.max(
                    minimum,
                    byCommand.get(command.commandId)?.outboxIds?.length ?? 0
                );
        },
        0
    );
}

export function countStateWriteAtomicCompletionFailures(commands, evidence) {
    return commands.filter((command) => command.status === 'accepted').filter((command) => {
        const operations = command.kind === 'profile-instance' ? ['profile', 'instance'] : ['command'];
        const completed = evidence.appInbox.filter((entry) =>
            entry?.commandId === command.commandId && entry.status === 'COMPLETED' && entry.resultStatus === 'COMPLETED'
        ).map((entry) => entry.operationId);
        const receipt = evidence.receipts.find((entry) => entry?.commandId === command.commandId);
        const effects = evidence.resourceOutbox.filter((entry) => entry?.commandId === command.commandId);
        return !sameIdentities(completed, operations) || !matchesStateWriteOutboxContract(command, receipt, effects);
    }).length;
}

function sameIdentities(actual, expected) {
    if (
        !Array.isArray(actual) || !Array.isArray(expected) ||
        actual.length !== expected.length
    ) {
        return false;
    }
    const identities = new Set(actual);
    return identities.size === actual.length &&
        new Set(expected).size === expected.length &&
        Array.from({ length: actual.length }, (_, index) => index).every((index) =>
            Object.hasOwn(actual, index) && Object.hasOwn(expected, index) &&
            typeof actual[index] === 'string' && actual[index].length > 0 &&
            identities.has(expected[index])
        );
}
