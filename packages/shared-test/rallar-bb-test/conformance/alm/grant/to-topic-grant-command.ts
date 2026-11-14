import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestHttpRequestCommand
} from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceRole } from '../alm-conformance-roles.ts';
import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { ALM_CONFORMANCE_GRANTED_TOPIC_ID, toCommandId, toRoomRef } from '../alm-conformance-step-identities.ts';
import { toAlmCellGroupPath } from '../cell/to-alm-cell-group-read.ts';
import { toPollCommand } from '../poll/alm-conformance-poll-commands.ts';
import { toPrincipalPlaceholder } from '../resolve-alm-conformance-principals.ts';
import { SUBSCRIPTION_COMMAND_TIMEOUT_MS, SUBSCRIPTION_PHASE_MS } from './subscription-phase-budgets.ts';

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
            path: `${toAlmCellGroupPath(step)}/publication-grants/${toPrincipalPlaceholder(grantee)}/${operation}` +
                `/requests/${toTopicRequestId(step, name)}-{loop.iteration}`,
            body: { topicId: ALM_CONFORMANCE_GRANTED_TOPIC_ID, publish: grant.publish, subscribe: grant.subscribe }
        },
        response: { body: 'json', acceptedStatusCodes: [200] },
        metadata: {
            purpose: `The room owner ${operation}s ${grantee} on the granted topic.`,
            group: toRoomRef(step.input.group)
        }
    };
    return toPollCommand({
        step,
        name,
        phaseMs: SUBSCRIPTION_PHASE_MS,
        commandTimeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
        commands: [request]
    });
}

/** A mutation request id: the page's runtime identity keeps a rerun from replaying an earlier run's answer. */
export function toTopicRequestId(step: AlmConformanceStepInput, name: string): string {
    return `alm-tsub-{runtimeIdentity}-${step.input.carrier}-${step.scenarioKey}-${step.role}-${name}`;
}

/** `p`, `s` or `ps`: a request id names the permissions short, so it stays within 128 characters. */
function toPermissionName(grant: TopicGrantInput): string {
    return `${grant.publish ? 'p' : ''}${grant.subscribe ? 's' : ''}`;
}
