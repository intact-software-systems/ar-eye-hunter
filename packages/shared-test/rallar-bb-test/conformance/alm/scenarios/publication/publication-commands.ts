import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import type { ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type { BlackBoxRallarRecipientPeer } from '../../../../../black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestLoopCommand,
    RallarBlackBoxTestMessagesSendCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { createStableRtcLayoutWait } from '../../../../fixtures/create-stable-rtc-layout-wait.ts';
import { CONNECT_READINESS_TIMEOUT_MS, NON_EXPIRING_SEND_TIMEOUT_MS } from '../../alm-conformance-budgets.ts';
import { toObserveCommand, toResultAssertion, toSendCommand } from '../../alm-conformance-message-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId, toLoopIterationSendHandleId } from '../../alm-conformance-step-identities.ts';

/**
 * Every paced cell's cadence. The ALM observation job of main run 40875760473 (86800bff2, `ws` smoke) measured the lead
 * send's `transport-accepted` 244 ms after staging and a loop of five sends 10 ms apart at 305 ms end to end, so at a
 * 500 ms cadence the loop straddled the second opportunity; locally the lead admits in 2 to 3 ms and the loop runs in
 * about 60 ms. The cadence must exceed the lead's admission plus the sends' spread with margin, and half of it, the
 * lead's budget, still proves an idle lane admits at once against a boundary one cadence away.
 */
export const PUBLICATION_CADENCE_MS = 2_000;

/** A paced cell's loop sends run 10 ms apart, far inside its cadence, so they meet in one staged window. */
const PUBLICATION_SEND_INTERVAL_MS = 10;

/** Far above one specimen's envelope, so only the drain's message budget decides a selection. */
export const PUBLICATION_DRAIN_BYTES = 64 * 1024;

/**
 * The share of the cadence within which send 0 must reach `transport-accepted`. An idle lane runs its opportunity on the
 * session engine's next pass, so the lead admission lands within a few ms; a stage that held the first value until its
 * lane's first boundary, one cadence later, misses this budget and fails the cell, which is how the cells prove D469's
 * "admitted at once" on an idle lane.
 */
const PUBLICATION_LEAD_OBSERVE_BUDGET_RATIO = 0.5;

/** A value the stage displaced, expired, cancelled or refused never reached a carrier admission. */
export const NEVER_ATTEMPTED: AlmPublicationFact = ['attempts', 0];

/**
 * The stage's own displacement detail, which the dispatch path's latest-wins supersedence at admission ("replaced this
 * one at its admission") does not carry. The lifecycle keeps no replacement message id, so this names the mechanism.
 */
export const STAGE_DISPLACED: AlmPublicationFact = ['reason', 'displaced it before its opportunity', 'contains'];

/** One field of an observation and the value it must hold: equal to it, or containing it. */
export type AlmPublicationFact = readonly [field: string, expected: string | number, operator?: 'contains'];

/** `one`: every loop send on the lead's stream; `one-per-send`: each iteration on a resource of its own. */
export type AlmPublicationLoopStreams = 'one' | 'one-per-send';

interface AlmPublicationSendsInput {
    readonly step: AlmConformanceStepInput;
    /** The sends after the lead send 0, which the loop names 1 to `burst`. */
    readonly burst: number;
    readonly publication: ALPublicationPolicy;
    /** The lifetime of sends 1 to `burst`. The lead send 0 always keeps the live channel's own. */
    readonly ttlMs: number;
    readonly streams: AlmPublicationLoopStreams;
}

interface AlmPublicationSendInput {
    readonly step: AlmConformanceStepInput;
    readonly index: number;
    readonly publication: ALPublicationPolicy;
    readonly ttlMs: number;
    /** Undefined on the lead's stream; otherwise the suffix of a resource of its own. */
    readonly stream: string | undefined;
    readonly recipientPeer: BlackBoxRallarRecipientPeer | undefined;
}

interface AlmPublicationLiveSend {
    readonly step: AlmConformanceStepInput;
    readonly index: number;
    readonly publication: ALPublicationPolicy;
    /** Undefined keeps the live channel's own lifetime. */
    readonly ttlMs: number | undefined;
    readonly resourceId: string;
    readonly recipientPeer: BlackBoxRallarRecipientPeer | undefined;
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
 * The lifetime of a value staged before the `opportunity`-th boundary after the lead's admission and carried by it: one
 * cadence past that boundary, since the live channel's own 1 000 ms would expire it before its first.
 */
export function toPublicationTtlMs(opportunity: number): number {
    return (opportunity + 1) * PUBLICATION_CADENCE_MS;
}

/**
 * Send 0 stages on the idle lane, whose opportunity runs on the session engine's next pass, so the sender waits for its
 * admission, bounded by `PUBLICATION_LEAD_OBSERVE_BUDGET_RATIO`: a send staged before that pass would displace it or
 * share its drain. Send 0 keeps the live channel's own lifetime, so a cell's short one never races its admission or
 * arrival.
 */
export function toPublicationLeadCommands(
    step: AlmConformanceStepInput,
    publication: ALPublicationPolicy,
    recipientPeer: BlackBoxRallarRecipientPeer | undefined
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...(step.input.carrier === 'ws' ? [] : [createStableRtcLayoutWait({
            group: step.input.group,
            prefix: toCommandId(step, 'publication'),
            timeoutMs: CONNECT_READINESS_TIMEOUT_MS
        })]),
        toLiveSendCommand({
            step,
            index: 0,
            publication,
            ttlMs: undefined,
            resourceId: toResourceId(step, undefined),
            recipientPeer
        }),
        ...toPublicationVerdictCommands({
            step,
            index: 0,
            state: 'transport-accepted',
            facts: [],
            budgetMs: publication.cadenceMs * PUBLICATION_LEAD_OBSERVE_BUDGET_RATIO
        })
    ];
}

/**
 * The lead, then a loop of sends 1 to `burst`: iteration `n` (from 1) names the handle of send `n` and carries `seq`
 * `n`, a number, since a loop writes a string that is only `{loop.iteration}` as the iteration's number. A command's
 * budget is the harness's own: a live send returns once it is staged.
 */
export function toPublicationSendCommands(sends: AlmPublicationSendsInput): readonly RallarBlackBoxTestCommand[] {
    return [...toPublicationLeadCommands(sends.step, sends.publication, undefined), toPublicationLoopCommand(sends)];
}

/** One send `index` with `seq` `index`, for a cell whose sends name their streams one by one. */
export function toPublicationSendCommand(send: AlmPublicationSendInput): RallarBlackBoxTestMessagesSendCommand {
    const { stream, ...live } = send;
    return toLiveSendCommand({ ...live, resourceId: toResourceId(send.step, stream) });
}

function toPublicationLoopCommand(sends: AlmPublicationSendsInput): RallarBlackBoxTestLoopCommand {
    const { step } = sends;
    const stream = sends.streams === 'one' ? undefined : '{loop.iteration}';
    return {
        kind: 'loop',
        commandId: toCommandId(step, 'paced-sends'),
        count: sends.burst,
        intervalMs: PUBLICATION_SEND_INTERVAL_MS,
        commands: [{
            ...toLiveSendCommand({
                step,
                index: 0,
                publication: sends.publication,
                ttlMs: sends.ttlMs,
                resourceId: toResourceId(step, stream),
                recipientPeer: undefined
            }),
            commandId: toCommandId(step, 'paced-send'),
            handleId: toLoopIterationSendHandleId(step),
            payload: { specimen: 'paced', seq: '{loop.iteration}' }
        }]
    };
}

function toResourceId(step: AlmConformanceStepInput, stream: string | undefined): string {
    return stream === undefined ? `alm-${step.scenarioKey}` : `alm-${step.scenarioKey}-${stream}`;
}

function toLiveSendCommand(send: AlmPublicationLiveSend): RallarBlackBoxTestMessagesSendCommand {
    const command = toSendCommand({
        ...send.step,
        index: send.index,
        payload: { specimen: 'paced', seq: send.index },
        delivery: {
            resourceId: send.resourceId,
            commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS,
            ...(send.ttlMs === undefined ? {} : { ttlMs: send.ttlMs }),
            ...(send.recipientPeer === undefined ? {} : { recipientPeer: send.recipientPeer })
        }
    });
    return { ...command, purpose: 'live', publication: send.publication };
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
