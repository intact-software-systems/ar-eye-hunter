import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestHttpRequestCommand
} from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceRole } from '../alm-conformance-roles.ts';
import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { ALM_CONFORMANCE_GRANTED_TOPIC_ID, toCommandId, toRoomRef } from '../alm-conformance-step-identities.ts';
import { toAlmCellGroupPath } from '../cell/to-alm-cell-group-read.ts';
import { toAlmCellRequestIdSuffix } from '../cell/to-alm-cell-request-id.ts';
import { toPollCommand } from '../poll/alm-conformance-poll-commands.ts';
import { toPrincipalPlaceholder } from '../resolve-alm-conformance-principals.ts';
import { SUBSCRIPTION_COMMAND_TIMEOUT_MS, SUBSCRIPTION_PHASE_MS } from './subscription-phase-budgets.ts';

type TopicGrantOperation = 'grant' | 'revoke';

interface TopicGrantInput {
    readonly step: AlmConformanceStepInput;
    /** The cell's start state, or a grant change that is a step of the cell itself, which command ids tell apart. */
    readonly scope: 'start-state' | 'cell';
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
    const { step } = grant;
    const name = toTopicGrantName(grant);
    return toPollCommand({
        step,
        name,
        phaseMs: SUBSCRIPTION_PHASE_MS,
        commandTimeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
        commands: [toTopicGrantRequest({
            grant,
            commandId: toCommandId(step, `${name}-request`),
            requestId: `${toTopicRequestId(step, name)}-{loop.iteration}`
        })]
    });
}

/**
 * The same grant or revoke as one request, for a writer whose grantee is already a member: a refusal then fails the
 * command instead of being asked again.
 */
export function toTopicGrantOnceCommand(grant: TopicGrantInput): RallarBlackBoxTestCommand {
    const { step } = grant;
    const name = toTopicGrantName(grant);
    return toTopicGrantRequest({
        grant,
        commandId: toCommandId(step, name),
        requestId: toTopicRequestId(step, name)
    });
}

interface TopicGrantRequestInput {
    readonly grant: TopicGrantInput;
    readonly commandId: string;
    readonly requestId: string;
}

function toTopicGrantRequest(
    { grant, commandId, requestId }: TopicGrantRequestInput
): RallarBlackBoxTestHttpRequestCommand {
    const { step, operation, grantee } = grant;
    return {
        kind: 'http.request',
        commandId,
        timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
        request: {
            method: 'POST',
            path: `${toAlmCellGroupPath(step)}/publication-grants/${toPrincipalPlaceholder(grantee)}/${operation}` +
                `/requests/${requestId}`,
            body: { topicId: ALM_CONFORMANCE_GRANTED_TOPIC_ID, publish: grant.publish, subscribe: grant.subscribe }
        },
        response: { body: 'json', acceptedStatusCodes: [200] },
        metadata: {
            purpose: `The room owner ${operation}s ${grantee} on the granted topic.`,
            group: toRoomRef(step.input.group)
        }
    };
}

function toTopicGrantName({ scope, operation, grantee, publish, subscribe }: TopicGrantInput): string {
    return `${scope === 'start-state' ? 'start-' : ''}${operation}-${grantee}-${
        toPermissionName({ publish, subscribe })
    }`;
}

/** A mutation request id: the page's runtime identity keeps a rerun from replaying an earlier run's answer. */
export function toTopicRequestId(step: AlmConformanceStepInput, name: string): string {
    return `alm-tsub-{runtimeIdentity}${toAlmCellRequestIdSuffix(step, name)}`;
}

/** `p`, `s` or `ps`: a request id names the permissions short, so it stays within 128 characters. */
function toPermissionName(grant: Pick<TopicGrantInput, 'publish' | 'subscribe'>): string {
    return `${grant.publish ? 'p' : ''}${grant.subscribe ? 's' : ''}`;
}
