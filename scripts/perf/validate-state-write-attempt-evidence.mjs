import {
    isDenseArray,
    isNonNegativeNumber,
    isObject
} from './api-v1-state-write-artifact-validation.mjs';

/**
 * @typedef {{ observations: unknown[], commandsById: Map<string, object>, path: string, errors: string[], appInboxEvidence: unknown }} DeriveAttemptsInput
 * @param {DeriveAttemptsInput} input
 */
export function deriveAttempts(
    { observations, commandsById, path, errors, appInboxEvidence }
) {
    if (!isDenseArray(observations)) {
        errors.push(`${path}.attemptObservations must be a dense array`);
        return {
            attempts: 0,
            conflicted: 0,
            transientRetries: 0,
            exhausted: 0,
            accepted: 0
        };
    }
    const { histories, conflicted, transientRetries } = validateAttemptObservations({
        observations,
        commandsById,
        path,
        errors
    });
    const historiesByCommand = new Map(
        [...commandsById.keys()].map((commandId) => [commandId, []])
    );
    for (const [historyKey, history] of histories) {
        const separator = historyKey.indexOf('\u0000');
        const commandId = historyKey.slice(0, separator);
        const operationId = historyKey.slice(separator + 1);
        historiesByCommand.get(commandId)?.push({ operationId, history });
        validateAttemptHistory({
            commandId,
            operationId,
            history,
            appInboxEvidence,
            path,
            errors
        });
    }
    const outcomes = deriveCommandOutcomes({
        commandsById,
        historiesByCommand,
        path,
        errors
    });
    return {
        attempts: observations.length,
        conflicted,
        transientRetries,
        ...outcomes
    };
}

function validateAttemptObservations(
    { observations, commandsById, path, errors }
) {
    const histories = new Map();
    let conflicted = 0;
    let transientRetries = 0;
    for (const [index, observation] of observations.entries()) {
        const observationPath = `${path}.attemptObservations[${index}]`;
        if (!isObject(observation) || !commandsById.has(observation.commandId)) {
            errors.push(`${observationPath}.commandId must link to a raw command`);
            continue;
        }
        if (
            typeof observation.operationId !== 'string' ||
            observation.operationId.length === 0
        ) {
            errors.push(`${observationPath}.operationId must be non-empty`);
            continue;
        }
        if (!Number.isInteger(observation.attempt) || observation.attempt < 0) {
            errors.push(`${observationPath}.attempt must be a non-negative integer`);
        }
        if (
            !['accepted', 'conflicted', 'transient-retry', 'exhausted'].includes(
                observation.outcome
            )
        ) {
            errors.push(`${observationPath}.outcome is invalid`);
        }
        if (
            typeof observation.source !== 'string' ||
            observation.source.trim().length === 0
        ) {
            errors.push(
                `${observationPath}.source must disclose a timing-sink source`
            );
        }
        validateAttemptFailure(observation, observationPath, errors);
        const terminalOutcome = observation.outcome === 'accepted' ||
            observation.outcome === 'exhausted';
        if (observation.terminal !== terminalOutcome) {
            errors.push(
                `${observationPath}.terminal must be false for conflicts and true for accepted/exhausted`
            );
        }
        const historyKey = `${observation.commandId}\u0000${observation.operationId}`;
        const history = histories.get(historyKey) ?? [];
        history.push({ ...observation, index });
        histories.set(historyKey, history);
        conflicted += observation.outcome === 'conflicted' ? 1 : 0;
        transientRetries += observation.outcome === 'transient-retry' ? 1 : 0;
    }

    return { histories, conflicted, transientRetries };
}

function deriveCommandOutcomes(
    { commandsById, historiesByCommand, path, errors }
) {
    let accepted = 0;
    let exhausted = 0;
    for (const [commandId, command] of commandsById) {
        const commandHistories = historiesByCommand.get(commandId) ?? [];
        if (commandHistories.length === 0) {
            errors.push(
                `${path}: attemptObservations must cover raw command ${commandId}`
            );
            continue;
        }
        const allowedOperations = command.kind === 'profile-instance'
            ? new Set(['profile', 'instance'])
            : new Set(['command']);
        if (
            commandHistories.some(({ operationId }) => !allowedOperations.has(operationId))
        ) {
            errors.push(
                `${path}: ${commandId} has an operationId outside its mutation contract`
            );
        }
        const terminalEvents = commandHistories.flatMap(({ history }) =>
            history.filter((observation) => observation.terminal === true)
        ).sort((left, right) => left.index - right.index);
        const firstExhausted = terminalEvents.findIndex((event) => event.outcome === 'exhausted');
        if (
            firstExhausted >= 0 &&
            terminalEvents.slice(firstExhausted + 1).some((event) => event.outcome === 'accepted')
        ) {
            errors.push(
                `${path}: ${commandId} cannot accept an operation after exhaustion`
            );
        }
        const derivedStatus = terminalEvents.some((event) => event.outcome === 'exhausted')
            ? 'exhausted'
            : 'accepted';
        if (command.status !== derivedStatus) {
            errors.push(
                `${path}: ${commandId} status does not match its coherent terminal attempt outcome`
            );
        }
        if (
            derivedStatus === 'accepted' &&
            commandHistories.length !== allowedOperations.size
        ) {
            errors.push(
                `${path}: ${commandId} accepted without every required operation terminal`
            );
        }
        accepted += derivedStatus === 'accepted' ? 1 : 0;
        exhausted += derivedStatus === 'exhausted' ? 1 : 0;
    }
    return { exhausted, accepted };
}

function validateAttemptHistory(
    { commandId, operationId, history, appInboxEvidence, path, errors }
) {
    const prerequisiteHistory = validateAttemptProvenance({
        commandId,
        operationId,
        history,
        path,
        errors
    });
    validateAttemptSequence({ commandId, operationId, history, path, errors });
    validateDurableAttemptCount({
        commandId,
        operationId,
        history,
        appInboxEvidence,
        prerequisiteHistory,
        path,
        errors
    });
    validateAttemptTerminal({ commandId, operationId, history, path, errors });
}

function validateAttemptProvenance(
    { commandId, operationId, history, path, errors }
) {
    const firstAttempt = history[0]?.attempt;
    const prerequisiteHistory = history.length === 1 &&
        history[0]?.attempt === 1 && history[0]?.outcome === 'exhausted' &&
        history[0]?.terminal === true && history[0]?.source.startsWith(
            'state-write-command-envelope.prerequisite-exhausted:'
        );
    if (prerequisiteHistory) {
        errors.push(
            `${path}: ${commandId}/${operationId} service-local prerequisite evidence is forbidden`
        );
    }
    const expectedFirstAttempt = 1;
    if (firstAttempt !== expectedFirstAttempt) {
        errors.push(
            `${path}: ${commandId}/${operationId} attempts must start at ${expectedFirstAttempt}`
        );
    }
    if (!prerequisiteHistory) {
        for (const observation of history) {
            if (
                observation.source !== 'resource_inbox.release.telemetry' ||
                !isNonNegativeNumber(observation.retryDelayMs) ||
                !isNonNegativeNumber(observation.dueAgeMs) ||
                !['fast', 'fairness', 'timeout'].includes(observation.selectedLane)
            ) {
                errors.push(
                    `${path}: ${commandId}/${operationId} production attempt source is not ` +
                        'production ResourceInbox release telemetry'
                );
                break;
            }
        }
    }
    return prerequisiteHistory;
}

function validateAttemptSequence(
    { commandId, operationId, history, path, errors }
) {
    const firstAttempt = history[0]?.attempt;
    for (const [index, observation] of history.entries()) {
        if (observation.attempt !== firstAttempt + index) {
            errors.push(
                `${path}: ${commandId}/${operationId} attempt numbers must be ordered and contiguous`
            );
            break;
        }
    }
}

function validateDurableAttemptCount(
    {
        commandId,
        operationId,
        history,
        appInboxEvidence,
        prerequisiteHistory,
        path,
        errors
    }
) {
    if (!prerequisiteHistory) {
        const durableAttempt = Array.isArray(appInboxEvidence)
            ? appInboxEvidence.find((entry) =>
                entry?.commandId === commandId &&
                entry?.operationId === operationId
            )
            : undefined;
        if (
            !durableAttempt || durableAttempt.attempts !== history.length ||
            durableAttempt.attempts !== history.at(-1)?.attempt
        ) {
            errors.push(
                `${path}: ${commandId}/${operationId} observed attempts must reconcile exactly ` +
                    'to durable AppInbox attempts'
            );
        }
    }
}

function validateAttemptTerminal(
    { commandId, operationId, history, path, errors }
) {
    const terminals = history.filter((observation) => observation.terminal === true);
    if (terminals.length !== 1) {
        errors.push(
            `${path}: ${commandId}/${operationId} must have exactly one terminal outcome`
        );
    }
    else if (history.at(-1) !== terminals[0]) {
        errors.push(
            `${path}: ${commandId}/${operationId} terminal outcome must be last`
        );
    }
    if (
        history.slice(0, -1).some((observation) => !['conflicted', 'transient-retry'].includes(observation.outcome))
    ) {
        errors.push(
            `${path}: ${commandId}/${operationId} only retries may precede a terminal`
        );
    }
    if (
        history.slice(0, -1).some((observation) =>
            !isNonNegativeNumber(observation.retryDelayMs) ||
            observation.retryDelayMs <= 0
        )
    ) {
        errors.push(
            `${path}: ${commandId}/${operationId} nonterminal retryDelayMs must be positive`
        );
    }
    const terminal = terminals[0];
    if (terminal?.outcome === 'exhausted') {
        const prerequisiteTerminal = history.length === 1 &&
            terminal.source.startsWith(
                'state-write-command-envelope.prerequisite-exhausted:'
            );
        const productionExhaustion = terminal.source === 'resource_inbox.release.telemetry' &&
            history.slice(0, -1).some((observation) =>
                observation.outcome === 'conflicted' &&
                observation.source === 'resource_inbox.release.telemetry'
            );
        if (!prerequisiteTerminal && !productionExhaustion) {
            errors.push(
                `${path}: ${commandId}/${operationId} production exhaustion must retain ` +
                    'a preceding production mutation.conflict observation'
            );
        }
    }
}

const OPTIMISTIC_CONFLICT_CODES = new Set([
    'app-inbox-reservation-conflict',
    'resource-inbox-lost-reservation',
    'runtime-state-write-conflict',
    'state-snapshot-read-conflict',
    'group-topology-commit-conflict'
]);
const OPTIMISTIC_CONFLICT_NAMES = new Set([
    'RuntimeStateWriteConflictError',
    'CrdtMutationConflictError',
    'StateSnapshotRevisionConflictError',
    'GroupTopologyCommitConflictError',
    'AppInboxReservationConflictError'
]);

function validateAttemptFailure(observation, path, errors) {
    const failure = observation.failure;
    if (
        !isObject(failure) ||
        !['none', 'retryable', 'non-retryable'].includes(failure.kind)
    ) {
        errors.push(`${path}.failure must carry a typed release failure`);
        return;
    }
    if (failure.kind === 'none') {
        if (
            Object.keys(failure).length !== 1 || observation.outcome !== 'accepted'
        ) {
            errors.push(`${path}.failure none is valid only for an accepted release`);
        }
        return;
    }
    if (
        Object.keys(failure).length !== 3 || typeof failure.code !== 'string' ||
        failure.code.length === 0 || typeof failure.name !== 'string' ||
        failure.name.length === 0
    ) {
        errors.push(`${path}.failure typed identity is malformed`);
        return;
    }
    const conflict = failure.kind === 'retryable' &&
        (OPTIMISTIC_CONFLICT_CODES.has(failure.code) ||
            OPTIMISTIC_CONFLICT_NAMES.has(failure.name));
    if ((observation.outcome === 'conflicted') !== conflict) {
        errors.push(
            `${path}.outcome must classify only recognized optimistic conflicts`
        );
    }
    if (
        observation.outcome === 'transient-retry' &&
        (failure.kind !== 'retryable' || conflict)
    ) {
        errors.push(
            `${path}.transient-retry must preserve a non-conflict retryable failure`
        );
    }
}
