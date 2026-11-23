import type {
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestMessagesReceivedCommand,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRuntimeStatus
} from '../../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../../schema/json-schema-validation.ts';
import type {
    AlmReceivedMessageIdentity,
    RallarBlackBoxTestMessagesReceivedResultValue
} from '../rallar-black-box-alm-result-values.ts';

export interface AlmReceivedOutcomeInput {
    readonly command: RallarBlackBoxTestMessagesReceivedCommand;
    readonly received: readonly AlmReceivedMessageIdentity[];
    /** `undefined` when the command claims no order. */
    readonly ascending: boolean | undefined;
    readonly stalled: boolean;
    /** The runtime status a passed count leaves in place. */
    readonly currentStatus: RallarBlackBoxTestRuntimeStatus;
}

/** The count's outcome, and the fixed-size summary its diagnostic carries in place of the unbounded copy list. */
export interface AlmReceivedJudgement {
    readonly outcome: RallarBlackBoxTestCommandOutcome;
    readonly summary: Omit<RallarBlackBoxTestMessagesReceivedResultValue, 'received'>;
}

interface AlmReceivedFailure {
    readonly code: string;
    readonly message: string;
}

const ALM_RECEIVED_ERROR_CODES = {
    notReceived: 'RALLAR_BLACK_BOX_ALM_MESSAGES_NOT_RECEIVED',
    receivedWhileAbsent: 'RALLAR_BLACK_BOX_ALM_MESSAGES_RECEIVED_WHILE_ABSENT',
    notAscending: 'RALLAR_BLACK_BOX_ALM_MESSAGES_NOT_ASCENDING'
} as const;

/** A copy whose payload lacks the field, or holds anything but a finite number there, ascends nothing. */
export function computeAlmPayloadFieldAscends(copies: readonly RallarBlackBoxTestRecord[], field: string): boolean {
    let previous = Number.NEGATIVE_INFINITY;
    for (const copy of copies) {
        const value = isJsonRecordValue(copy.payload) ? copy.payload[field] : undefined;
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= previous) {
            return false;
        }
        previous = value;
    }
    return true;
}

/** The count is judged first: an order is claimed of the copies the count asked for. */
export function toAlmReceivedOutcome(input: AlmReceivedOutcomeInput): AlmReceivedJudgement {
    const { command, stalled } = input;
    const absent = command.absent === true;
    const observed = input.received.length;
    const counted = absent ? observed < Math.max(command.count, 1) : observed >= command.count;
    const summary = {
        typeId: command.typeId,
        ...(command.msgId === undefined ? {} : { msgId: command.msgId }),
        count: command.count,
        observed,
        absent,
        ...(input.ascending === undefined ? {} : { ascending: input.ascending }),
        ...(command.stallMs === undefined ? {} : { stall: { stallMs: command.stallMs, stalled } })
    };
    const value: RallarBlackBoxTestMessagesReceivedResultValue = { ...summary, received: input.received };
    const outcome: RallarBlackBoxTestCommandOutcome = counted && input.ascending !== false
        ? { status: 'ok', value, nextStatus: input.currentStatus }
        : {
            status: 'failed',
            value,
            error: { ...toAlmReceivedFailure(input, observed, counted), details: value },
            nextStatus: 'failed'
        };
    return { outcome, summary };
}

/** A count that was met leaves the order as the claim that failed. */
function toAlmReceivedFailure(
    { command, stalled }: AlmReceivedOutcomeInput,
    observed: number,
    counted: boolean
): AlmReceivedFailure {
    const observation = `messages.received observed ${observed} ${command.typeId} messages`;
    if (counted) {
        return {
            code: ALM_RECEIVED_ERROR_CODES.notAscending,
            message: `${observation} whose payload ${command.ascendingBy} does not strictly ascend in arrival order.`
        };
    }
    return {
        code: command.absent === true
            ? ALM_RECEIVED_ERROR_CODES.receivedWhileAbsent
            : ALM_RECEIVED_ERROR_CODES.notReceived,
        message: stalled
            ? `${observation} against count ${command.count}, no new copy arriving within its ${command.stallMs} ms ` +
                'stall window.'
            : `${observation} against count ${command.count}.`
    };
}
