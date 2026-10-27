import type { ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import { ALM_REPLY_WAIT_RESPONSE_MARGIN_MS } from '../../../../alm/browser-adapter-alm-commands.ts';
import type { RallarBlackBoxTestMessagesAwaitReplyResultValue } from '../../../../alm/rallar-black-box-alm-result-values.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, toBudgetMs } from '../../alm-conformance-budgets.ts';
import {
    ALM_INBOUND_DIAGNOSTICS_TOPIC,
    toSentMsgIdReference,
    toVerdictTimeoutMs
} from '../../alm-conformance-diagnostic-waits.ts';
import { toResultAssertion } from '../../alm-conformance-message-commands.ts';
import type { AlmConformanceMessageStepInput } from '../../alm-conformance-scenario-definition.ts';
import {
    toCommandId,
    toConnectionName,
    toReplyHandleId,
    toScenarioTypeId,
    toSendHandleId
} from '../../alm-conformance-step-identities.ts';

/** The adapter's own evidence of a reply wait: its `data` is the command's value, in its emitted key order. */
const REPLY_AWAITED_TOPIC = 'rallar.bb.messages.reply_awaited';

interface AlmConformanceReplyWait {
    /** How long the page waits; the command's budget adds the margin the page needs to report a timeout. */
    readonly timeoutMs: number;
    readonly status: RallarBlackBoxTestMessagesAwaitReplyResultValue['status'];
    /** Absent when the request may still be on its way to its receipt as the reply arrives. */
    readonly requestState?: ALDeliveryState;
}

/** The send of `request.index` awaits its reply, and the wait's status, and the request's state if named, hold. */
export function toAwaitReplyCommands(
    request: AlmConformanceMessageStepInput,
    wait: AlmConformanceReplyWait
): readonly RallarBlackBoxTestCommand[] {
    const resultName = toAwaitReplyName(request);
    return [
        {
            kind: 'messages.awaitReply',
            commandId: toCommandId(request, resultName),
            connection: toConnectionName(request),
            handleId: toSendHandleId(request),
            timeoutMs: toBudgetMs(wait.timeoutMs + ALM_REPLY_WAIT_RESPONSE_MARGIN_MS, request.input.deadlineMs)
        },
        toResultAssertion({
            step: request,
            name: `assert-reply-${wait.status}-${request.index}`,
            resultName,
            field: 'status',
            operator: 'equals',
            expected: wait.status
        }),
        ...(wait.requestState === undefined ? [] : [
            toResultAssertion({
                step: request,
                name: `assert-reply-request-${wait.requestState}-${request.index}`,
                resultName,
                field: 'state',
                operator: 'equals',
                expected: wait.requestState
            })
        ])
    ];
}

/**
 * The reply names the request's msgId as its `replyToMsgId` and as its `corrId`, the request's correlation is that
 * msgId too, and it takes the request's type. `responder` names the reply's sender where the cell knows it, as a
 * `{resultCache…}` token; the waits read the value the adapter stated, since an assert compares with no token.
 */
export function toReplyIdentityCommands(
    request: AlmConformanceMessageStepInput,
    responder: string | undefined
): readonly RallarBlackBoxTestCommand[] {
    const msgId = toSentMsgIdReference(request);
    return [
        toResultAssertion({
            step: request,
            name: `assert-reply-type-${request.index}`,
            resultName: toAwaitReplyName(request),
            field: 'reply.typeId',
            operator: 'equals',
            expected: toScenarioTypeId(request)
        }),
        toReplyAwaitedWait(request, 'reply-correlation', `"corrId":"${msgId}","reply":{"msgId":"`),
        toReplyAwaitedWait(
            request,
            'reply-identity',
            `"replyToMsgId":"${msgId}","corrId":"${msgId}","senderId":"${
                responder === undefined ? '' : `${responder}"`
            }`
        )
    ];
}

/**
 * The requester's inbound diagnostic for a reply it dropped as late, `cause` saying why: its wait timed out first, or
 * another reply answered first. The type pins the cell, the request's msgId the request.
 */
export function toReplyLateWait(
    request: AlmConformanceMessageStepInput,
    cause: 'replied' | 'timed-out'
): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(request, `reply-late-${cause}-${request.index}`),
        match: {
            kind: 'diagnostic',
            topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
            payloadFields: { 'data.kind': 'reply-late', 'data.typeId': toScenarioTypeId(request), 'data.cause': cause },
            payloadPath: 'data',
            contains: `"replyToMsgId":"${toSentMsgIdReference(request)}"`
        },
        timeoutMs: toVerdictTimeoutMs(request.input.deadlineMs)
    };
}

/**
 * The responder replies to the `index`-th arrival of the cell's type under a handle of its own, then reads the reply
 * acknowledged: the requester admitted it, whether it matched a wait or arrived late.
 */
export function toReplyCommands(responder: AlmConformanceMessageStepInput): readonly RallarBlackBoxTestCommand[] {
    const handleId = toReplyHandleId(responder);
    const observeName = `observe-reply-acknowledged-${responder.index}`;
    return [
        {
            kind: 'messages.reply',
            commandId: toCommandId(responder, `reply-${responder.index}`),
            connection: toConnectionName(responder),
            typeId: toScenarioTypeId(responder),
            index: responder.index,
            payload: { marker: responder.scenarioKey, carrier: responder.input.carrier, role: responder.role },
            handleId
        },
        {
            kind: 'messages.observe',
            commandId: toCommandId(responder, observeName),
            connection: toConnectionName(responder),
            handleId,
            state: ['acknowledged'],
            timeoutMs: toBudgetMs(NON_EXPIRING_SEND_TIMEOUT_MS, responder.input.deadlineMs)
        },
        toResultAssertion({
            step: responder,
            name: `assert-reply-acknowledged-${responder.index}`,
            resultName: observeName,
            field: 'state',
            operator: 'equals',
            expected: 'acknowledged'
        })
    ];
}

function toAwaitReplyName(request: AlmConformanceMessageStepInput): string {
    return `await-reply-${request.index}`;
}

/** The event is the reply wait's own and is stated before the wait runs, so the wait reads the history once. */
function toReplyAwaitedWait(
    request: AlmConformanceMessageStepInput,
    name: string,
    contains: string
): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(request, `${name}-${request.index}`),
        match: {
            kind: 'diagnostic',
            topic: REPLY_AWAITED_TOPIC,
            commandId: toCommandId(request, toAwaitReplyName(request)),
            payloadPath: 'data',
            contains
        },
        timeoutMs: 0
    };
}
