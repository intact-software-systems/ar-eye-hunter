import { toAssertSourceRoots } from '../assert/compute-assert-command-outcome.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestState,
    RallarBlackBoxTestWaitCommand,
    RallarBlackBoxTestWaitMatch
} from '../rallar-black-box-test-contracts.ts';
import type { ResultCaptureReceipt } from '../result-release/result-release-protocol.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { readResultReferencesInText } from '../wait/resolve-wait-match-result-references.ts';
import {
    decodePathSegmentsReference,
    resolveLatestWaitEvent,
    toPayloadPathSegments
} from '../wait/wait-event-match.ts';

export interface ReleasedResultReferenceEvidence {
    readonly releasedCommands: ReadonlyMap<string, ResultCaptureReceipt>;
    readonly ownedResultEvents: Pick<WeakSet<RallarBlackBoxTestEvent>, 'has'>;
    readonly state: RallarBlackBoxTestState;
}

/** Released evidence must never become successful absence evidence at command admission. */
export function resolveReleasedResultReference(
    command: RallarBlackBoxTestCommand,
    evidence: ReleasedResultReferenceEvidence
): RallarBlackBoxTestCommandOutcome | undefined {
    if (evidence.releasedCommands.size === 0 && evidence.state.resultHistory.releasedResults === 0) {
        return undefined;
    }
    const sources = command.kind === 'assert'
        ? [command.source, ...(command.operator === 'sameUniqueStringSet' ? [command.comparisonSource] : [])]
        : toReferenceTexts(command).filter((text) => typeof text === 'string').flatMap(readResultReferencesInText);
    const unavailable = sources.filter((source) => typeof source === 'string')
        .find((source) => isReleasedSourceReference(source, evidence)) ??
        (command.kind === 'wait' ? resolveReleasedWaitPayloadReference(command, evidence) : undefined);
    return unavailable === undefined ? undefined : {
        status: 'failed',
        error: {
            code: 'RALLAR_BLACK_BOX_RESULT_RELEASED',
            message:
                `The full result referenced by ${unavailable} was released after durable capture and is unavailable.`
        },
        nextStatus: 'failed'
    };
}

function isReleasedSourceReference(source: string, evidence: ReleasedResultReferenceEvidence): boolean {
    const [root, ...path] = source.trim().split('.').filter((part) => part.length > 0);
    const parts = [root, ...toPayloadPathSegments(path.join('.'))];
    if (isReleasedEventPayloadReference(parts, evidence)) {
        return true;
    }
    if (parts[0] === 'state') {
        parts.shift();
    }
    if (parts[0] === 'resultCache') {
        return parts[1] === undefined ? evidence.releasedCommands.size > 0 : evidence.releasedCommands.has(parts[1]);
    }
    if (parts[0] === 'lastResult') {
        return evidence.state.resultHistory.lastCommandId !== undefined &&
            evidence.releasedCommands.has(evidence.state.resultHistory.lastCommandId);
    }
    return ['commandHistory', 'results', 'failures'].includes(parts[0]) &&
        evidence.state.resultHistory.releasedResults > 0;
}

function isReleasedEventPayloadReference(
    parts: readonly string[],
    evidence: ReleasedResultReferenceEvidence
): boolean {
    const [root, ...segments] = parts;
    if (!['events', 'recentEvents'].includes(root) && !(root === 'state' && segments[0] === 'events')) {
        return false;
    }
    const payloadIndex = root === 'state' ? 2 : 1;
    const member = segments[payloadIndex + 1];
    if (segments[payloadIndex] !== 'payload' || member === undefined) {
        return false;
    }
    const roots = toAssertSourceRoots({ state: evidence.state, config: undefined });
    const reference = decodePathSegmentsReference(roots, [root, ...segments.slice(0, payloadIndex)]);
    const event = evidence.state.events.find((event) => event === reference.object);
    return event !== undefined && isReleasedEventPayloadUnavailable(event, [member], evidence);
}

function resolveReleasedWaitPayloadReference(
    command: RallarBlackBoxTestWaitCommand,
    evidence: ReleasedResultReferenceEvidence
): string | undefined {
    const members = toWaitPayloadMembers(command.match);
    if (members.length === 0) {
        return undefined;
    }
    const events = evidence.state.events;
    const actual = command.absent === true ? undefined : resolveLatestWaitEvent(events, command.match);
    if (actual !== undefined && !isReleasedEventPayloadUnavailable(actual, members, evidence)) {
        return undefined;
    }
    const {
        payloadPath: _payloadPath,
        payloadFields: _payloadFields,
        equals: _equals,
        contains: _contains,
        exists: _exists,
        ...routing
    } = command.match;
    return events.some((event) =>
            resolveLatestWaitEvent([event], routing) !== undefined &&
            isReleasedEventPayloadUnavailable(event, members, evidence)
        )
        ? 'wait.match payload'
        : undefined;
}

function toWaitPayloadMembers(match: RallarBlackBoxTestWaitMatch): readonly (string | undefined)[] {
    const members = Object.keys(match.payloadFields ?? {}).map((path) => toPayloadPathSegments(path)[0]);
    const member = toPayloadPathSegments(match.payloadPath)[0];
    if (member !== undefined || match.equals !== undefined || match.contains !== undefined) {
        members.push(member);
    }
    return members;
}

function isReleasedEventPayloadUnavailable(
    event: RallarBlackBoxTestEvent,
    members: readonly (string | undefined)[],
    evidence: ReleasedResultReferenceEvidence
): boolean {
    const marker = event.payload;
    return evidence.ownedResultEvents.has(event) && isJsonRecordValue(marker) &&
        marker.resultUnavailable === 'released-after-durable-capture' && Object.keys(marker).length === 3 &&
        marker.commandId === event.commandId && isJsonRecordValue(marker.capture) &&
        members.some((member) => member === undefined || !Object.hasOwn(marker, member));
}

function toReferenceTexts(command: RallarBlackBoxTestCommand): readonly string[] {
    switch (command.kind) {
        case 'wait':
            return command.match?.contains === undefined ? [] : [command.match.contains];
        case 'messages.control':
            return [command.msgId, command.ackedMsgId, command.toPeerId];
        case 'fault.inject':
            return command.carrier === 'storage' || command.match?.msgId === undefined ? [] : [command.match.msgId];
        default:
            return [];
    }
}
