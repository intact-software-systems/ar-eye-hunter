import { GROUP_LAYOUT_IDENTITY_KEYS } from '@shared/api/group-lifecycle/group-layout-identity.ts';

import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';
import {
    SUBSCRIPTION_COMMAND_TIMEOUT_MS,
    SUBSCRIPTION_PHASE_MS
} from '../granted-topic/subscription-phase-budgets.ts';
import { toReadPollCommand } from '../poll/alm-conformance-poll-commands.ts';
import { PATH_TOPOLOGY } from './to-path-topology-config-command.ts';

/**
 * The page reads its own health, which names its accepted layout, until that layout is a tree whose identity is the
 * accepted layout of the room head the page read before the poll (`headReadCommandId`). In a room the family shares, a
 * page may still hold an earlier reshaped cell's tree; only the identity tells it from the one this reshape settled on.
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
        facts: [
            {
                name: 'reshape-in-force-topology',
                source: { read: 'read', field: 'rallar.formation.accepted.overlay.topology' },
                operator: 'equals',
                expected: PATH_TOPOLOGY.topologyKind
            },
            ...GROUP_LAYOUT_IDENTITY_KEYS.map((key) => ({
                name: `reshape-in-force-${key}`,
                source: { read: 'read', field: `rallar.formation.accepted.identity.${key}` },
                equalsResult: `resultCache.${headReadCommandId}.value.body.group.acceptedLayoutIdentity.${key}`
            }))
        ]
    });
}
