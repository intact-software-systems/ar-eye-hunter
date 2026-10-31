import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestHttpRequestCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import type { AlmConformanceRole } from '../../alm-conformance-roles.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import {
    ALM_CONFORMANCE_GRANTED_TOPIC_ID,
    toCommandId,
    toConnectionName,
    toRoomRef,
    toScenarioTypeId
} from '../../alm-conformance-step-identities.ts';
import { toPrincipalPlaceholder } from '../../resolve-alm-conformance-principals.ts';
import {
    SUBSCRIPTION_COMMAND_TIMEOUT_MS,
    toPollCommand,
    toPollResult,
    toResultFact
} from './topic-subscription-polls.ts';

/** Every cell is a granted-topic proof, which a granted channel carries over WS only. */
export const TOPIC_SUBSCRIPTION_CARRIERS: readonly AlmConformanceCarrier[] = ['ws', 'rtc-with-ws-fallback'];

/** Every cell's connects listen on the granted topic and open their room channel there as granted. */
export const TOPIC_SUBSCRIPTION_SELECTOR = { topicId: ALM_CONFORMANCE_GRANTED_TOPIC_ID, access: 'granted' } as const;

export type TopicGrantOperation = 'grant' | 'revoke';

export interface TopicGrantInput {
    readonly step: AlmConformanceStepInput;
    readonly operation: TopicGrantOperation;
    /** The role whose principal the grant names; the sender and the sibling share one. */
    readonly grantee: AlmConformanceRole;
    readonly publish: boolean;
    readonly subscribe: boolean;
}

/**
 * The group owner's grant or revoke of `{ publish, subscribe }` on the granted topic. A grantee that has not joined
 * yet is refused `member-not-active`, so each attempt is a request of its own until one answers 200.
 */
export function toTopicGrantCommand(grant: TopicGrantInput): RallarBlackBoxTestCommand {
    const { step, operation, grantee } = grant;
    const name = `${operation}-${grantee}-${toPermissionName(grant)}`;
    const request: RallarBlackBoxTestHttpRequestCommand = {
        kind: 'http.request',
        commandId: toCommandId(step, `${name}-request`),
        timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
        request: {
            method: 'POST',
            path: `${toGroupPath(step)}/publication-grants/${toPrincipalPlaceholder(grantee)}/${operation}` +
                `/requests/${toTopicRequestId(step, name)}-{loop.iteration}`,
            body: { topicId: ALM_CONFORMANCE_GRANTED_TOPIC_ID, publish: grant.publish, subscribe: grant.subscribe }
        },
        response: { body: 'json', acceptedStatusCodes: [200] },
        metadata: {
            purpose: `The room owner ${operation}s ${grantee} on the granted topic.`,
            group: toRoomRef(step.input.group)
        }
    };
    return toPollCommand(step, name, [request]);
}

/** Elects the page's session to receive the granted topic under `subscriptionId`, retrying a refusal until active. */
export function toSubscribeCommand(step: AlmConformanceStepInput, subscriptionId: string): RallarBlackBoxTestCommand {
    const name = `subscribe-${subscriptionId}`;
    const subscribe = toCommandId(step, `${name}-token`);
    return toPollCommand(step, name, [
        {
            kind: 'messages.subscribe',
            commandId: subscribe,
            connection: toConnectionName(step),
            subscriptionId,
            timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS
        },
        toResultFact({
            step,
            name: `${name}-active`,
            source: `${toPollResult({ step, name, index: 1, childId: subscribe })}.status`,
            operator: 'equals',
            expected: 'active'
        })
    ]);
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
        request: { method: 'GET', path: `${toGroupPath(step)}/sessions/{auth.sessionId}/subscriptions` },
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
            path: `${toGroupPath(step)}/sessions/{auth.sessionId}/unsubscribe` +
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

/** `p`, `s` or `ps`: a request id names the permissions short, so it stays within 128 characters. */
function toPermissionName(grant: TopicGrantInput): string {
    return `${grant.publish ? 'p' : ''}${grant.subscribe ? 's' : ''}`;
}

function toGroupPath(step: AlmConformanceStepInput): string {
    const group = step.input.group;
    return `/api/state/apps/${group.applicationId}/workspaces/${group.workspaceId}/groups/${group.groupId}`;
}

/** A mutation request id: the page's runtime identity keeps a rerun from replaying an earlier run's answer. */
function toTopicRequestId(step: AlmConformanceStepInput, name: string): string {
    return `alm-tsub-{runtimeIdentity}-${step.input.carrier}-${step.scenarioKey}-${step.role}-${name}`;
}
