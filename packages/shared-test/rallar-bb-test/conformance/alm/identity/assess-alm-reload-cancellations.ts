import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../rallar-black-box-test-contracts.ts';
import { decodeJsonValue } from '../../../runtime/decode-runtime-result-values.ts';
import { isJsonRecordValue } from '../../../schema/json-schema-validation.ts';
import { isSameJsonValue } from '../../../wait/wait-event-match.ts';
import type { AlmReloadCheckpoint } from '../alm-reload-pair.ts';
import type { RecordedAlmConformanceParticipant } from './assess-alm-conformance-identity.ts';
import { toRecordedAlmResultValue } from './to-recorded-alm-result-value.ts';

/** A reload pair's sends beside the original: each is cancelled before the reload and must never arrive. */
export interface AlmReloadCancellationsInput {
    readonly sender: RecordedAlmConformanceParticipant;
    readonly receiver: RecordedAlmConformanceParticipant;
    readonly checkpoint: AlmReloadCheckpoint;
    readonly prefix: readonly RallarBlackBoxTestCommand[];
    readonly recovery: readonly RallarBlackBoxTestCommand[];
    readonly send: RallarBlackBoxTestMessagesSendCommand;
    readonly cancelled: readonly RallarBlackBoxTestMessagesSendCommand[];
    /** The receiver's wait for the recovered original, after which each cancelled send is proven absent. */
    readonly receive: RallarBlackBoxTestWaitCommand | undefined;
}

/**
 * Each cancelled send is cancelled before the reload, reads `cancelled`, and is proven absent after the original
 * arrives: the restored page resumes the original and not the cancelled message.
 */
export function assessAlmReloadCancellations(input: AlmReloadCancellationsInput): readonly string[] {
    return input.cancelled.every((cancelled) => isUnresumedCancellation(input, cancelled))
        ? []
        : [`${input.checkpoint.key}: a cancelled send must read cancelled before the reload and never arrive.`];
}

function isUnresumedCancellation(
    input: AlmReloadCancellationsInput,
    cancelled: RallarBlackBoxTestMessagesSendCommand
): boolean {
    const { prefix, recovery, send, receive } = input;
    const cancel = prefix.find((command) =>
        command.kind === 'messages.cancel' && command.handleId === cancelled.handleId
    );
    const absence = recovery.find((command): command is RallarBlackBoxTestWaitCommand =>
        command.kind === 'wait' && command.absent === true && command.match.kind === 'message' &&
        command.match.payloadPath === 'data.payload' &&
        isSameJsonValue(command.match.equals, decodeJsonValue(cancelled.payload))
    );
    const cancelValue = toRecordedAlmResultValue(input.sender, cancel);
    const absenceValue = toRecordedAlmResultValue(input.receiver, absence);
    return typeof cancelled.handleId === 'string' && cancelled.handleId.length > 0 &&
        cancelled.handleId !== send.handleId &&
        !isSameJsonValue(decodeJsonValue(cancelled.payload), decodeJsonValue(send.payload)) &&
        cancel !== undefined && prefix.indexOf(cancel) > prefix.indexOf(cancelled) &&
        isJsonRecordValue(cancelValue) && cancelValue.state === 'cancelled' &&
        absence !== undefined && receive !== undefined && recovery.indexOf(absence) > recovery.indexOf(receive) &&
        isJsonRecordValue(absenceValue) && absenceValue.absent === true && absenceValue.matched === false;
}
