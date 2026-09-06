import {
    compareNumber,
    isDenseArray,
    isDenseStringArray,
    isNonNegativeNumber,
    isObject,
    sameStringArray
} from './api-v1-state-write-artifact-validation.mjs';
import {
    countStateWriteAtomicCompletionFailures,
    matchesStateWriteOutboxContract,
    PRODUCTION_STATE_WRITE_MUTATION_CONTRACT,
    requiredStateWriteOutboxCount
} from './api-v1-state-write-outbox-contract.mjs';
import {
    isValidPersistedResult,
    validateReceiptResultBindings
} from './api-v1-state-write-result-binding.mjs';

/**
 * @typedef {{ sample: unknown, commandsById: Map<string, object>, path: string, errors: string[] }} DeriveFinalDurableCorrectnessInput
 * @param {DeriveFinalDurableCorrectnessInput} input
 */
export function deriveFinalDurableCorrectness(
    { sample, commandsById, path, errors }
) {
    const evidence = sample.durableEvidence;
    if (!isObject(evidence)) {
        errors.push(`${path}.durableEvidence must be an object`);
        return emptyDurableCorrectness();
    }
    validateDurableEvidenceShape(evidence, path, errors);
    const appInbox = Array.isArray(evidence.appInbox) ? evidence.appInbox : [];
    const receipts = Array.isArray(evidence.receipts) ? evidence.receipts : [];
    const resourceOutbox = Array.isArray(evidence.resourceOutbox)
        ? evidence.resourceOutbox
        : [];
    const acceptedCommands = [...commandsById.values()].filter((command) => command.status === 'accepted');
    validateReceiptEvidence({
        receipts,
        commandsById,
        acceptedCommands,
        path,
        errors
    });
    const receiptsByCommand = new Map(
        receipts.map((receipt) => [receipt?.commandId, receipt])
    );
    validateAppInboxEvidence({
        entries: appInbox,
        commandsById: commandsById,
        receiptsByCommand: receiptsByCommand,
        path: path,
        errors: errors
    });
    validateOutboxEvidence({ resourceOutbox, commandsById, path, errors });
    const completion = { acceptedCommands, appInbox, receipts, resourceOutbox };
    validateOutboxReceiptLinks({ ...completion, receiptsByCommand, path, errors });
    validateAtomicCompletion({ ...completion, sample, path, errors });
    return {
        receiptCount: receipts.length,
        effectfulCommandCount:
            acceptedCommands.filter((command) => PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind].length > 0)
                .length,
        requiredOutboxIntentCount: requiredStateWriteOutboxCount(
            acceptedCommands,
            receipts
        ),
        outboxIntentCount: resourceOutbox.length
    };
}

function validateDurableEvidenceShape(evidence, path, errors) {
    for (
        const field of [
            'appInbox',
            'receipts',
            'resourceOutbox',
            'intermediateMutationIntents'
        ]
    ) {
        if (!isDenseArray(evidence[field])) {
            errors.push(`${path}.durableEvidence.${field} must be a dense array`);
        }
    }
    if (!isDenseArray(evidence.intermediateMutationIntents, 0)) {
        errors.push(
            `${path}.durableEvidence.intermediateMutationIntents must be exactly empty`
        );
    }
    if (
        !Number.isInteger(evidence.atomicCompletionFailures) ||
        evidence.atomicCompletionFailures < 0
    ) {
        errors.push(
            `${path}.durableEvidence.atomicCompletionFailures must be a non-negative integer`
        );
    }
}

function validateReceiptEvidence(
    { receipts, commandsById, acceptedCommands, path, errors }
) {
    const receiptIds = receipts.map((receipt, index) => {
        if (
            !isObject(receipt) || typeof receipt.commandId !== 'string' ||
            !commandsById.has(receipt.commandId) ||
            !isDenseStringArray(receipt.receiptIds) ||
            !isDenseStringArray(receipt.outboxIds) ||
            !isDenseArray(receipt.resultBindings) ||
            !['logical-msg-id', 'physical-resource-id'].includes(receipt.identityKind)
        ) {
            errors.push(
                `${path}.durableEvidence.receipts[${index}] is malformed or unlinked`
            );
        }
        validateReceiptResultBindings(
            receipt,
            commandsById.get(receipt?.commandId),
            path,
            index,
            errors
        );
        if (
            isDenseStringArray(receipt?.receiptIds) &&
            new Set(receipt.receiptIds).size !== receipt.receiptIds.length
        ) {
            errors.push(
                `${path}.durableEvidence.receipts[${index}] receipt IDs must be unique`
            );
        }
        if (
            isDenseStringArray(receipt?.outboxIds) &&
            new Set(receipt.outboxIds).size !== receipt.outboxIds.length
        ) {
            errors.push(
                `${path}.durableEvidence.receipts[${index}] outbox IDs must be unique`
            );
        }
        return receipt?.commandId;
    });
    if (
        !sameStringArray(
            receiptIds.toSorted(),
            acceptedCommands.map((entry) => entry.commandId).toSorted()
        )
    ) {
        errors.push(
            `${path}.durableEvidence receipts must match accepted command IDs exactly`
        );
    }
}

function validateOutboxEvidence(
    { resourceOutbox, commandsById, path, errors }
) {
    const effectIds = new Set();
    for (const [index, effect] of resourceOutbox.entries()) {
        if (
            !isObject(effect) || typeof effect.effectId !== 'string' ||
            effect.effectId.length === 0 ||
            typeof effect.commandId !== 'string' ||
            !commandsById.has(effect.commandId) ||
            typeof effect.effectKind !== 'string' || effect.effectKind.length === 0 ||
            typeof effect.resourceId !== 'string' || effect.resourceId.length === 0 ||
            typeof effect.outboxId !== 'string' || effect.outboxId.length === 0 ||
            !['APP_OUTBOX', 'WS_OUTBOX'].includes(effect.typeId) ||
            typeof effect.topicId !== 'string' || effect.topicId.length === 0
        ) {
            errors.push(
                `${path}.durableEvidence.resourceOutbox[${index}] is malformed or unlinked`
            );
        }
        if (effectIds.has(effect?.effectId)) {
            errors.push(
                `${path}.durableEvidence resource outbox effect IDs must be unique`
            );
        }
        effectIds.add(effect?.effectId);
    }
}

function validateOutboxReceiptLinks(
    {
        acceptedCommands,
        receiptsByCommand,
        resourceOutbox,
        receipts,
        appInbox,
        path,
        errors
    }
) {
    for (const command of acceptedCommands) {
        const receipt = receiptsByCommand.get(command.commandId);
        const effects = resourceOutbox.filter((effect) => effect?.commandId === command.commandId);
        if (!matchesStateWriteOutboxContract(command, receipt, effects)) {
            errors.push(
                `${path}.durableEvidence resource outbox does not match the mutation contract`
            );
        }
    }
    for (const receipt of receipts) {
        const exactEffects = resourceOutbox.filter((effect) => effect?.commandId === receipt?.commandId).map((effect) =>
            effect.effectId
        ).toSorted();
        if (!sameStringArray((receipt?.outboxIds ?? []).toSorted(), exactEffects)) {
            errors.push(
                `${path}.durableEvidence receipt outbox IDs must match exact ResourceInbox effects`
            );
        }
    }
    for (const entry of appInbox) {
        const embedded = embeddedResultReceipt(entry);
        if (embedded === undefined) {
            continue;
        }
        const authoritative = receipts.find((receipt) => receipt?.commandId === entry?.commandId);
        if (
            !authoritative ||
            !authoritative.receiptIds.includes(embedded.commandId) ||
            !sameStringArray(
                authoritative.outboxIds.toSorted(),
                embedded.outboxIds.toSorted()
            )
        ) {
            errors.push(
                `${path}.durableEvidence embedded result receipt must match authoritative receipt and effects`
            );
        }
    }
}

function validateAtomicCompletion(
    {
        sample,
        acceptedCommands,
        appInbox,
        receipts,
        resourceOutbox,
        path,
        errors
    }
) {
    const evidence = sample.durableEvidence;
    const atomicFailures = countStateWriteAtomicCompletionFailures(acceptedCommands, {
        appInbox,
        receipts,
        resourceOutbox
    });
    compareNumber({
        actual: evidence.atomicCompletionFailures,
        expected: atomicFailures,
        path: `${path}.durableEvidence.atomicCompletionFailures`,
        errors: errors,
        source: 'same-observation durable completion'
    });
    compareNumber({
        actual: sample.correctness?.atomicCompletionFailures,
        expected: atomicFailures,
        path: `${path}.correctness.atomicCompletionFailures`,
        errors: errors,
        source: 'same-observation durable completion'
    });
}

/**
 * @typedef {{ entries: unknown[], commandsById: Map<string, object>, receiptsByCommand: Map<string, object>, path: string, errors: string[] }} ValidateAppInboxEvidenceInput
 * @param {ValidateAppInboxEvidenceInput} input
 */
function validateAppInboxEvidence(
    { entries, commandsById, receiptsByCommand, path, errors }
) {
    const identities = new Set();
    for (const [index, entry] of entries.entries()) {
        if (
            !isObject(entry) || typeof entry.commandId !== 'string' ||
            !commandsById.has(entry.commandId) ||
            typeof entry.operationId !== 'string' ||
            entry.operationId.length === 0 || typeof entry.resourceId !== 'string' ||
            entry.resourceId.length === 0 || typeof entry.topicId !== 'string' ||
            entry.topicId.length === 0 || typeof entry.contextId !== 'string' ||
            entry.contextId.length === 0 || entry.status !== 'COMPLETED' ||
            entry.resultStatus !== 'COMPLETED' || !Number.isInteger(entry.attempts) ||
            entry.attempts < 1 || !isNonNegativeNumber(entry.retryDelayMs) ||
            !isNonNegativeNumber(entry.dueAgeMs) ||
            !['fast', 'fairness', 'timeout'].includes(entry.selectedLane) ||
            !isNonNegativeNumber(entry.transactionDurationMs)
        ) {
            errors.push(
                `${path}.durableEvidence.appInbox[${index}] is malformed or incomplete`
            );
        }
        const binding = receiptsByCommand.get(entry?.commandId)?.resultBindings
            ?.find(
                (candidate) => candidate?.operationId === entry?.operationId
            );
        if (
            !isValidPersistedResult(
                entry,
                commandsById.get(entry?.commandId),
                binding
            )
        ) {
            errors.push(
                `${path}.durableEvidence.appInbox[${index}] persisted durable result is malformed`
            );
        }
        const identity = `${entry?.commandId}\u0000${entry?.operationId}`;
        if (identities.has(identity)) {
            errors.push(
                `${path}.durableEvidence AppInbox command/operation identities must be unique`
            );
        }
        identities.add(identity);
    }
}

function embeddedResultReceipt(entry) {
    if (!isObject(entry?.durableResult)) {
        return undefined;
    }
    const result = entry.durableResult;
    const receipt = entry.commandType?.startsWith('GROUP_PRESENCE_')
        ? result
        : entry.commandType?.startsWith('TOPOLOGY_')
        ? result.receipt
        : undefined;
    return isObject(receipt) && typeof receipt.commandId === 'string' &&
            isDenseStringArray(receipt.outboxIds)
        ? { commandId: receipt.commandId, outboxIds: receipt.outboxIds }
        : undefined;
}

function emptyDurableCorrectness() {
    return {
        receiptCount: 0,
        effectfulCommandCount: 0,
        requiredOutboxIntentCount: 0,
        outboxIntentCount: 0
    };
}
