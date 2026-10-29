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

/**
 * The share of the cadence within which send 0 must reach `transport-accepted`. An idle lane runs its opportunity on the
 * session engine's next pass, so the lead admission lands within a few ms; a stage that held the first value until its
 * lane's first boundary, one cadence later, misses this budget and fails the cell, which is how the cells prove D469's
 * "admitted at once" on an idle lane.
 */
export const PUBLICATION_LEAD_OBSERVE_BUDGET_RATIO = 0.5;

/** A value the stage displaced or expired never reached a carrier admission. */
export const NEVER_ATTEMPTED: AlmPublicationFact = ['attempts', 0];

/**
 * The stage's own displacement detail, which the dispatch path's latest-wins supersedence at admission ("replaced this
 * one at its admission") does not carry. The lifecycle keeps no replacement message id, so this names the mechanism.
 */
export const STAGE_DISPLACED: AlmPublicationFact = ['reason', 'displaced it before its opportunity', 'contains'];

/** One field of an observation and the value it must hold: equal to it, or containing it. */
export type AlmPublicationFact = readonly [field: string, expected: string | number, operator?: 'contains'];

interface AlmPublicationSendsInput {
    readonly step: AlmConformanceStepInput;
    /** The sends after the lead send 0, which the loop names 1 to `burst`. */
    readonly burst: number;
    readonly publication: ALPublicationPolicy;
    /** The lifetime of sends 1 to `burst`; absent, the live channel's own. The lead send 0 always keeps the channel's. */
    readonly ttlMs?: number;
}

interface AlmPublicationVerdictInput {
    readonly step: AlmConformanceStepInput;
    readonly index: number;
    readonly state: ALDeliveryState;
    readonly facts: readonly AlmPublicationFact[];
    /** Absent, the state's own budget. */
    readonly budgetMs?: number;
}

/**
 * Live sends of one specimen on one resource, so one stream key. Send 0 stages on the idle lane, whose opportunity runs
 * on the session engine's next pass, so the sender waits for its admission, bounded by
 * `PUBLICATION_LEAD_OBSERVE_BUDGET_RATIO`: a send staged before that pass would displace it or share its drain. Send 0
 * keeps the live channel's own lifetime, so a cell's short one never races its admission or arrival. The
 * loop then sends 1 to `burst`: iteration `n` (from 1) names the handle of send
 * `n` and carries `seq` `n`, a number, since a loop writes a string that is only `{loop.iteration}` as the
 * iteration's number. A command's budget is the harness's own: a live send returns once it is staged.
 */
export function toPublicationSendCommands(sends: AlmPublicationSendsInput): readonly RallarBlackBoxTestCommand[] {
    const { step } = sends;
    const lead = toLiveSendCommand(sends, undefined);
    return [
        lead,
        ...toPublicationVerdictCommands({
            step,
            index: 0,
            state: 'transport-accepted',
            facts: [],
            budgetMs: sends.publication.cadenceMs * PUBLICATION_LEAD_OBSERVE_BUDGET_RATIO
        }),
        {
            kind: 'loop',
            commandId: toCommandId(step, 'paced-sends'),
            count: sends.burst,
            intervalMs: PUBLICATION_SEND_INTERVAL_MS,
            commands: [{
                ...toLiveSendCommand(sends, sends.ttlMs),
                commandId: toCommandId(step, 'paced-send'),
                handleId: toLoopIterationSendHandleId(step),
                payload: { specimen: 'paced', seq: '{loop.iteration}' }
            }]
        }
    ];
}

function toLiveSendCommand(
    sends: AlmPublicationSendsInput,
    ttlMs: number | undefined
): RallarBlackBoxTestMessagesSendCommand {
    const send = toSendCommand({
        ...sends.step,
        index: 0,
        payload: { specimen: 'paced', seq: 0 },
        delivery: {
            resourceId: `alm-${sends.step.scenarioKey}`,
            commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS,
            ...(ttlMs === undefined ? {} : { ttlMs })
        }
    });
    return { ...send, purpose: 'live', publication: sends.publication };
}

/** Send `index`'s handle reaches `state`, its observation states it, and each fact holds on that observation. */
export function toPublicationVerdictCommands(
    { step, index, state, facts, budgetMs }: AlmPublicationVerdictInput
): readonly RallarBlackBoxTestCommand[] {
    const resultName = `observe-${state}-${index}`;
    return [
        toObserveCommand({ ...step, index, state, ...(budgetMs === undefined ? {} : { budgetMs }) }),
        toResultAssertion({
            step,
            name: `assert-${state}-${index}`,
            resultName,
            field: 'state',
            operator: 'equals',
            expected: state
        }),
        ...facts.map(([field, expected, operator]) =>
            toResultAssertion({
                step,
                name: `assert-${field.replace('.', '-')}-${index}`,
                resultName,
                field,
                operator: operator ?? 'equals',
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
 * `arrived`: the specimen carrying `seq` has arrived. `not-yet`: read from the page's history at once, it has not; right
 * after an arrival count this orders that arrival before the specimen a later opportunity carries. The read assumes the
 * count resolves well inside one cadence of the arrival it waited for, which a slow hosted receiver could break (red,
 * never falsely green); S1-ii's hosted placement revisits it.
 */
export function toSeqArrivalWait(
    receiver: AlmConformanceStepInput,
    seq: number,
    expectation: 'arrived' | 'not-yet'
): RallarBlackBoxTestWaitCommand {
    const arrived = expectation === 'arrived';
    const wait = toPayloadWait({
        step: receiver,
        name: `${expectation}-seq-${seq}`,
        payload: { specimen: 'paced', seq },
        absent: !arrived
    });
    return {
        ...wait,
        match: { ...wait.match, payloadFields: { 'data.typeId': toScenarioTypeId(receiver) } },
        ...(arrived ? {} : { timeoutMs: 0 })
    };
}
