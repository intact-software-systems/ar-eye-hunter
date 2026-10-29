import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import type { ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesReceivedCommand,
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, RESPONSE_MARGIN_MS } from '../../alm-conformance-budgets.ts';
import { toObserveCommand, toResultAssertion, toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toPayloadWait, toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId, toLoopIterationSendHandleId, toScenarioTypeId } from '../../alm-conformance-step-identities.ts';

/** A paced cell's sends run 10 ms apart, far inside its cadence of 500 ms or more, so they meet in one staged window. */
export const PUBLICATION_SEND_INTERVAL_MS = 10;

/** Far above one specimen's envelope, so only the drain's message budget decides a selection. */
export const PUBLICATION_DRAIN_BYTES = 64 * 1024;

/** A value the stage displaced or expired never reached a carrier admission. */
export const NEVER_ATTEMPTED: AlmPublicationFact = ['attempts', 0];

/** One field of an observation and the value it must hold. */
export type AlmPublicationFact = readonly [field: string, expected: string | number];

interface AlmPublicationSendsInput {
    readonly step: AlmConformanceStepInput;
    /** The sends after the lead send 0, which the loop names 1 to `burst`. */
    readonly burst: number;
    readonly publication: ALPublicationPolicy;
    /** Absent, the live channel's own lifetime. */
    readonly ttlMs?: number;
}

interface AlmPublicationVerdictInput {
    readonly step: AlmConformanceStepInput;
    readonly index: number;
    readonly state: ALDeliveryState;
    readonly facts: readonly AlmPublicationFact[];
}

/**
 * Live sends of one specimen on one resource, so one stream key. Send 0 stages on the idle lane, whose opportunity runs
 * on the session engine's next pass, so the sender waits for its admission: a send staged before that pass would
 * displace it or share its drain. The loop then sends 1 to `burst`: iteration `n` (from 1) names the handle of send
 * `n` and carries `seq` `n`, a number, since a loop writes a string that is only `{loop.iteration}` as the
 * iteration's number. A command's budget is the harness's own: a live send returns once it is staged.
 */
export function toPublicationSendCommands(sends: AlmPublicationSendsInput): readonly RallarBlackBoxTestCommand[] {
    const { step } = sends;
    const lead = toLiveSendCommand(sends);
    return [
        lead,
        ...toPublicationVerdictCommands({ step, index: 0, state: 'transport-accepted', facts: [] }),
        {
            kind: 'loop',
            commandId: toCommandId(step, 'paced-sends'),
            count: sends.burst,
            intervalMs: PUBLICATION_SEND_INTERVAL_MS,
            commands: [{
                ...lead,
                commandId: toCommandId(step, 'paced-send'),
                handleId: toLoopIterationSendHandleId(step),
                payload: { specimen: 'paced', seq: '{loop.iteration}' }
            }]
        }
    ];
}

function toLiveSendCommand(sends: AlmPublicationSendsInput): RallarBlackBoxTestMessagesSendCommand {
    const send = toSendCommand({
        ...sends.step,
        index: 0,
        payload: { specimen: 'paced', seq: 0 },
        delivery: {
            resourceId: `alm-${sends.step.scenarioKey}`,
            commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS,
            ...(sends.ttlMs === undefined ? {} : { ttlMs: sends.ttlMs })
        }
    });
    return { ...send, purpose: 'live', publication: sends.publication };
}

/** Send `index`'s handle reaches `state`, its observation states it, and each fact holds on that observation. */
export function toPublicationVerdictCommands(
    { step, index, state, facts }: AlmPublicationVerdictInput
): readonly RallarBlackBoxTestCommand[] {
    const resultName = `observe-${state}-${index}`;
    return [
        toObserveCommand({ ...step, index, state }),
        toResultAssertion({
            step,
            name: `assert-${state}-${index}`,
            resultName,
            field: 'state',
            operator: 'equals',
            expected: state
        }),
        ...facts.map(([field, expected]) =>
            toResultAssertion({
                step,
                name: `assert-${field.replace('.', '-')}-${index}`,
                resultName,
                field,
                operator: 'equals',
                expected
            })
        )
    ];
}

/** The receiver holds `count` arrivals of the cell's type, within the sender's whole send budget. */
export function toArrivalCountCommand(
    receiver: AlmConformanceStepInput,
    count: number
): RallarBlackBoxTestMessagesReceivedCommand {
    return toReceivedCommand({ ...receiver, index: count, count, absent: false });
}

/** No arrival past the `count - 1` the receiver holds within `windowMs`, which opens at the last expected one. */
export function toNoFurtherArrivalCommand(
    receiver: AlmConformanceStepInput,
    count: number,
    windowMs: number
): RallarBlackBoxTestMessagesReceivedCommand {
    return {
        ...toReceivedCommand({ ...receiver, index: count, count, absent: true }),
        windowMs,
        timeoutMs: windowMs + RESPONSE_MARGIN_MS
    };
}

/**
 * The specimen carrying `seq` has arrived, or, read from the page's history at once, has not arrived yet: right
 * after an arrival count, the second orders that arrival before the specimen a later opportunity carries.
 */
export function toSeqArrivalWait(
    receiver: AlmConformanceStepInput,
    seq: number,
    arrived: boolean
): RallarBlackBoxTestWaitCommand {
    const wait = toPayloadWait({
        step: receiver,
        name: arrived ? `arrived-seq-${seq}` : `not-yet-seq-${seq}`,
        payload: { specimen: 'paced', seq },
        absent: !arrived
    });
    return {
        ...wait,
        match: { ...wait.match, payloadFields: { 'data.typeId': toScenarioTypeId(receiver) } },
        ...(arrived ? {} : { timeoutMs: 0 })
    };
}
