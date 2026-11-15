import { GROUP_LAYOUT_IDENTITY_KEYS } from '@shared/api/group-lifecycle/group-layout-identity.ts';

import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';
import {
    SUBSCRIPTION_COMMAND_TIMEOUT_MS,
    SUBSCRIPTION_PHASE_MS
} from '../granted-topic/subscription-phase-budgets.ts';
import { toReadPollCommand } from '../poll/alm-conformance-poll-commands.ts';

/**
 * The page reads its own health, which names its accepted layout, until that layout is the accepted layout of the room
 * head the page read before the poll (`headReadCommandId`) or one that replaced it, never an earlier one. That read
 * follows `formation-settled` on the room the reshape asked for, whose accepted layout then matches the path's config,
 * so the identity names the path's tree. In a room the family shares, a page may still hold an earlier reshaped cell's
 * tree; only the identity tells it from the one this reshape settled on. A re-plan after the head read, an RTT re-plan
 * or a presence change, replaces the head's layout with one whose revisions and `version` are each at or after the
 * head's, so those keys are held at or after it and `state` is held equal. Each key is its own fact, so a fact reads one
 * number or state, and an attempt stays small enough for the runtime's loop limit over the poll's phase.
 */
export function toReshapeInForcePollCommand(
    step: AlmConformanceStepInput,
    headReadCommandId: string
): RallarBlackBoxTestCommand {
    return toReadPollCommand({
        step,
        name: 'reshape-in-force',
        phaseMs: SUBSCRIPTION_PHASE_MS,
        commandTimeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
        reads: [{
            name: 'read',
            read: (readName) => ({
                kind: 'health',
                commandId: toCommandId(step, readName),
                timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS
            })
        }],
        facts: GROUP_LAYOUT_IDENTITY_KEYS.map((key) => ({
            name: `reshape-in-force-${key}`,
            source: { read: 'read', field: `rallar.formation.accepted.identity.${key}` },
            operator: key === 'state' ? 'equals' : 'gte',
            result: `resultCache.${headReadCommandId}.value.body.group.acceptedLayoutIdentity.${key}`
        }))
    });
}
