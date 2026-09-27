import type {
    RallarBlackBoxTestBarrierCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestRuntimeEventInput
} from '../rallar-black-box-test-contracts.ts';
import { decodePayloadPathValue } from '../wait/wait-event-match.ts';
import { waitForEvent, type WaitForEventInput } from '../wait/wait-for-event.ts';
import {
    decodeBarrierResolution,
    RALLAR_BLACK_BOX_BARRIER_ARRIVED_TOPIC,
    RALLAR_BLACK_BOX_BARRIER_RESOLVED_TOPIC,
    toBarrierArrivedEvent
} from './control-barrier-protocol.ts';

/**
 * The control server closes the barrier's window on the next envelope any agent sends; the agent listens this much
 * longer, so its own timeout means no control server answered, never a slow verdict.
 */
export const RALLAR_BLACK_BOX_BARRIER_RESOLUTION_GRACE_MS = 10_000;

export const RALLAR_BLACK_BOX_BARRIER_FAILED = 'RALLAR_BLACK_BOX_BARRIER_FAILED';
export const RALLAR_BLACK_BOX_BARRIER_TIMEOUT = 'RALLAR_BLACK_BOX_BARRIER_TIMEOUT';
export const RALLAR_BLACK_BOX_BARRIER_REUSED = 'RALLAR_BLACK_BOX_BARRIER_REUSED';

type BarrierCommandWithId = RallarBlackBoxTestBarrierCommand & Readonly<{ commandId: string; }>;

export interface WaitForBarrierInput extends Omit<WaitForEventInput, 'command'> {
    readonly command: BarrierCommandWithId;
    readonly recordEvent: (event: RallarBlackBoxTestRuntimeEventInput) => void;
}

export async function waitForBarrier(input: WaitForBarrierInput): Promise<RallarBlackBoxTestCommandOutcome> {
    const { command } = input;
    if (input.currentEvents().some((event) => isArrivalAt(event, command.barrierId))) {
        return toBarrierFailure(command, {
            code: RALLAR_BLACK_BOX_BARRIER_REUSED,
            message: 'A barrier id is single-use: this agent already arrived at it.',
            details: { barrierId: command.barrierId }
        });
    }
    input.recordEvent(toBarrierArrivedEvent(command));
    const waited = await waitForEvent({
        ...input,
        command: {
            kind: 'wait',
            commandId: command.commandId,
            timeoutMs: command.timeoutMs + RALLAR_BLACK_BOX_BARRIER_RESOLUTION_GRACE_MS,
            ...(command.deadlineEpochMs === undefined ? {} : { deadlineEpochMs: command.deadlineEpochMs }),
            match: {
                kind: 'event',
                topic: RALLAR_BLACK_BOX_BARRIER_RESOLVED_TOPIC,
                payloadPath: 'barrierId',
                equals: command.barrierId
            }
        }
    });
    return toBarrierOutcome(input, waited);
}

function isArrivalAt(event: RallarBlackBoxTestEvent, barrierId: string): boolean {
    const arrivedAt = decodePayloadPathValue(event.payload, 'barrierId');
    return event.topic === RALLAR_BLACK_BOX_BARRIER_ARRIVED_TOPIC && arrivedAt.exists && arrivedAt.value === barrierId;
}

function toBarrierOutcome(
    input: WaitForBarrierInput,
    waited: RallarBlackBoxTestCommandOutcome
): RallarBlackBoxTestCommandOutcome {
    const { command } = input;
    if (waited.status === 'cancelled') {
        return {
            status: 'cancelled',
            value: { barrierId: command.barrierId, cancelled: true },
            nextStatus: 'cancelled'
        };
    }
    const carried = decodePayloadPathValue(waited.value, 'event.payload.resolution');
    const resolution = waited.status === 'ok' && carried.exists
        ? decodeBarrierResolution(carried.value).right
        : undefined;
    if (resolution === undefined) {
        return toBarrierFailure(command, {
            code: RALLAR_BLACK_BOX_BARRIER_TIMEOUT,
            message:
                'No barrier resolution arrived from the control server within timeoutMs plus the resolution grace.',
            details: { timeoutMs: command.timeoutMs, graceMs: RALLAR_BLACK_BOX_BARRIER_RESOLUTION_GRACE_MS }
        });
    }
    if (resolution.outcome === 'failed') {
        return toBarrierFailure(command, {
            code: RALLAR_BLACK_BOX_BARRIER_FAILED,
            message: `Barrier ${command.barrierId} failed: ${resolution.reason}.`,
            details: resolution
        });
    }
    return {
        status: 'ok',
        value: { barrierId: command.barrierId, outcome: 'released', arrivedAgentIds: resolution.arrivedAgentIds },
        nextStatus: input.currentStatus()
    };
}

function toBarrierFailure(
    command: BarrierCommandWithId,
    error: NonNullable<RallarBlackBoxTestCommandOutcome['error']>
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        value: { barrierId: command.barrierId, outcome: 'failed' },
        error,
        nextStatus: 'failed'
    };
}
