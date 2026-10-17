import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestState
} from '../rallar-black-box-test-contracts.ts';
import type { ResultCaptureReceipt } from '../result-release/result-release-protocol.ts';
import { readResultReferencesInText } from '../wait/resolve-wait-match-result-references.ts';

/** Tombstones are admission policy: a missing captured result must never mean a successful absence assertion. */
export function resolveReleasedResultReference(
    command: RallarBlackBoxTestCommand,
    released: ReadonlyMap<string, ResultCaptureReceipt>,
    state: RallarBlackBoxTestState
): RallarBlackBoxTestCommandOutcome | undefined {
    if (released.size === 0) {
        return undefined;
    }
    const sources = command.kind === 'assert'
        ? [command.source, ...(command.operator === 'sameUniqueStringSet' ? [command.comparisonSource] : [])]
        : readReferenceTexts(command).filter((text) => typeof text === 'string').flatMap(readResultReferencesInText);
    const unavailable = sources.filter((source) => typeof source === 'string').find((source) => {
        const parts = source.trim().split('.').filter((part) => part.length > 0);
        if (parts[0] === 'state') {
            parts.shift();
        }
        if (parts[0] === 'resultCache') {
            return parts[1] === undefined ? released.size > 0 : released.has(parts[1]);
        }
        if (parts[0] === 'lastResult') {
            return state.resultHistory.lastCommandId !== undefined && released.has(state.resultHistory.lastCommandId);
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
