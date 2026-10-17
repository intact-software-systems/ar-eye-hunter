import { toAssertSourceRoots } from '../assert/compute-assert-command-outcome.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestState
} from '../rallar-black-box-test-contracts.ts';
import type { ResultCaptureReceipt } from '../result-release/result-release-protocol.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { readResultReferencesInText } from '../wait/resolve-wait-match-result-references.ts';
import { decodePathSegmentsReference, toPayloadPathSegments } from '../wait/wait-event-match.ts';

export interface ReleasedResultReferenceEvidence {
    readonly releasedCommands: ReadonlyMap<string, ResultCaptureReceipt>;
    readonly ownedResultEvents: Pick<WeakSet<RallarBlackBoxTestEvent>, 'has'>;
    readonly state: RallarBlackBoxTestState;
}

/** Tombstones are admission policy: a missing captured result must never mean a successful absence assertion. */
export function resolveReleasedResultReference(
    command: RallarBlackBoxTestCommand,
    evidence: ReleasedResultReferenceEvidence
): RallarBlackBoxTestCommandOutcome | undefined {
    const { releasedCommands, state } = evidence;
    if (releasedCommands.size === 0 && state.resultHistory.releasedResults === 0) {
        return undefined;
    }
    const sources = command.kind === 'assert'
        ? [command.source, ...(command.operator === 'sameUniqueStringSet' ? [command.comparisonSource] : [])]
        : readReferenceTexts(command).filter((text) => typeof text === 'string').flatMap(readResultReferencesInText);
    const unavailable = sources.filter((source) => typeof source === 'string').find((source) => {
        if (isReleasedEventPayloadReference(source, evidence)) {
            return true;
        }
        const parts = source.trim().split('.').filter((part) => part.length > 0);
        if (parts[0] === 'state') {
            parts.shift();
        }
        if (parts[0] === 'resultCache') {
            return parts[1] === undefined ? releasedCommands.size > 0 : releasedCommands.has(parts[1]);
        }
        if (parts[0] === 'lastResult') {
            return state.resultHistory.lastCommandId !== undefined &&
                releasedCommands.has(state.resultHistory.lastCommandId);
        }
        return ['commandHistory', 'results', 'failures'].includes(parts[0]) && state.resultHistory.releasedResults > 0;
    });
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

function isReleasedEventPayloadReference(
    source: string,
    evidence: ReleasedResultReferenceEvidence
): boolean {
    const [root, ...parts] = source.trim().split('.').filter((part) => part.length > 0);
    const segments = toPayloadPathSegments(parts.join('.'));
    if (!['events', 'recentEvents'].includes(root) && !(root === 'state' && segments[0] === 'events')) {
        return false;
    }
    const payloadIndex = root === 'state' ? 2 : 1;
    if (segments[payloadIndex] !== 'payload') {
        return false;
    }
    const roots = toAssertSourceRoots({ state: evidence.state, config: undefined });
    const reference = decodePathSegmentsReference(roots, [root, ...segments.slice(0, payloadIndex)]);
    const event = evidence.state.events.find((event) => event === reference.object);
    if (event === undefined || !evidence.ownedResultEvents.has(event) || !isJsonRecordValue(event.payload)) {
        return false;
    }
    const marker = event.payload;
    const member = segments[payloadIndex + 1];
    return marker.resultUnavailable === 'released-after-durable-capture' && Object.keys(marker).length === 3 &&
        marker.commandId === event.commandId && isJsonRecordValue(marker.capture) &&
        member !== undefined && !Object.hasOwn(marker, member);
}

function readReferenceTexts(command: RallarBlackBoxTestCommand): readonly string[] {
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
