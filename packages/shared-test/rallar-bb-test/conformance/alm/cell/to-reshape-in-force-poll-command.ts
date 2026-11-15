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
 * The page reads its own health, which names its accepted layout, until that layout's identity is the accepted layout
 * of the room head the page read before the poll (`headReadCommandId`). That read follows `formation-settled` on the
 * room the reshape asked for, whose accepted layout then matches the path's config, so the identity names the path's
 * tree. In a room the family shares, a page may still hold an earlier reshaped cell's tree; only the identity tells it
 * from the one this reshape settled on. Each key is its own fact, so a fact reads one number or state, and an attempt
 * stays small enough for the runtime's loop limit over the poll's phase. Each key is held equal, not at or after the
 * head's: the runtime's `assert` compares two results by equality alone. So a re-plan after the head read, an RTT
 * re-plan or a presence change, makes the page accept a newer identity and the poll fail as a false red, never a false
 * green: a `reshape-in-force` timeout whose last read names a later `version` than the head read.
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
            equalsResult: `resultCache.${headReadCommandId}.value.body.group.acceptedLayoutIdentity.${key}`
        }))
    });
}
