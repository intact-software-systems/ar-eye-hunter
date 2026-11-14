import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestHttpRequestCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import type {
    AlmConformanceStartGrant,
    AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import {
    ALM_CONFORMANCE_GRANTED_TOPIC_ID,
    toCommandId,
    toConnectionName,
    toScenarioTypeId
} from '../../alm-conformance-step-identities.ts';
import { toAlmCellGroupPath } from '../../cell/to-alm-cell-group-read.ts';
import { SUBSCRIPTION_COMMAND_TIMEOUT_MS, SUBSCRIPTION_PHASE_MS } from '../../grant/subscription-phase-budgets.ts';
import { toTopicRequestId } from '../../grant/to-topic-grant-command.ts';
import { toPollCommand, toPollResult, toResultFact } from '../../poll/alm-conformance-poll-commands.ts';

/**
 * The granted-topic proof's carriers, which a cell narrows only for a reason of its own: over ws the server's
 * intersection decides who receives, and over rtc and the fallback carrier a receipted granted send rides RTC as a
 * signed room multicast, frozen to the sessions whose principal holds `subscribe`, which deliver to
 * `subscribe(handler)` only under an active election.
 */
export const TOPIC_SUBSCRIPTION_CARRIERS: readonly AlmConformanceCarrier[] = ['ws', 'rtc', 'rtc-with-ws-fallback'];

/**
 * Both producers hold `publish` and `subscribe` and the receiver `subscribe`; the sibling shares the sender's
 * principal, so it holds what the sender does.
 */
export const PRODUCERS_START_GRANTS: readonly AlmConformanceStartGrant[] = [
    { grantee: 'receiver', publish: false, subscribe: true },
    { grantee: 'publisher-b', publish: true, subscribe: true },
    { grantee: 'sender', publish: true, subscribe: true }
];

/** Every cell's connects listen on the granted topic and open their room channel there as granted. */
export const TOPIC_SUBSCRIPTION_SELECTOR = { topicId: ALM_CONFORMANCE_GRANTED_TOPIC_ID, access: 'granted' } as const;

/** Elects the page's session to receive the granted topic under `subscriptionId`, retrying a refusal until active. */
export function toSubscribeCommand(step: AlmConformanceStepInput, subscriptionId: string): RallarBlackBoxTestCommand {
    const name = `subscribe-${subscriptionId}`;
    const subscribe = toCommandId(step, `${name}-token`);
    return toPollCommand({
        step,
        name,
        phaseMs: SUBSCRIPTION_PHASE_MS,
        commandTimeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
        commands: [
            {
                kind: 'messages.subscribe',
                commandId: subscribe,
                connection: toConnectionName(step),
                subscriptionId,
                timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS
            },
            toResultFact({
                timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
                step,
                name: `${name}-active`,
                source: `${toPollResult({ step, name, index: 1, childId: subscribe })}.status`,
                operator: 'equals',
                expected: 'active'
            })
        ]
    });
}

export function toUnsubscribeCommands(
    step: AlmConformanceStepInput,
    subscriptionId: string
): readonly RallarBlackBoxTestCommand[] {
    const unsubscribe = toCommandId(step, `unsubscribe-${subscriptionId}`);
    return [
        {
            kind: 'messages.unsubscribe',
            commandId: unsubscribe,
            connection: toConnectionName(step),
            subscriptionId,
            timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS
        },
        toResultFact({
            timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
            step,
            name: `unsubscribe-${subscriptionId}-lapsed`,
            source: `resultCache.${unsubscribe}.value.status`,
            operator: 'equals',
            expected: 'lapsed'
        })
    ];
}

/** The page's tokens and its socket's connection generation, read under `name`. */
export function toTokenReadCommand(step: AlmConformanceStepInput, name: string): RallarBlackBoxTestCommand {
    return {
        kind: 'messages.subscriptions',
        commandId: toCommandId(step, name),
        connection: toConnectionName(step),
        timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS
    };
}

/** The server's subscription rows of the page's own session, read under `name`. */
export function toSubscriptionRowsCommand(
    step: AlmConformanceStepInput,
    name: string
): RallarBlackBoxTestHttpRequestCommand {
    return {
        kind: 'http.request',
        commandId: toCommandId(step, name),
        timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
        request: { method: 'GET', path: `${toAlmCellGroupPath(step)}/sessions/{auth.sessionId}/subscriptions` },
        response: { body: 'json', acceptedStatusCodes: [200] }
    };
}

/** The session's own release of the row a generation asserted, sent as a stale tab would send it. */
export function toUnsubscribeRequestCommand(
    step: AlmConformanceStepInput,
    connectionGenerationId: string
): RallarBlackBoxTestHttpRequestCommand {
    return {
        kind: 'http.request',
        commandId: toCommandId(step, 'stale-unsubscribe'),
        timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
        request: {
            method: 'POST',
            path: `${toAlmCellGroupPath(step)}/sessions/{auth.sessionId}/unsubscribe` +
                `/requests/${toTopicRequestId(step, 'stale-unsubscribe')}`,
            body: { topicId: ALM_CONFORMANCE_GRANTED_TOPIC_ID, connectionGenerationId }
        },
        response: { body: 'json', acceptedStatusCodes: [200] }
    };
}

export function toProductSocketCommand(
    step: AlmConformanceStepInput,
    action: 'close' | 'reopen'
): RallarBlackBoxTestCommand {
    return {
        kind: 'fault.inject',
        commandId: toCommandId(step, `product-socket-${action}`),
        faultId: `${toScenarioTypeId(step)}.product-socket`,
        carrier: 'product-socket',
        action,
        timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS
    };
}
