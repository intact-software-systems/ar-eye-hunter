import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';
import {
    SUBSCRIPTION_COMMAND_TIMEOUT_MS,
    SUBSCRIPTION_PHASE_MS
} from '../granted-topic/subscription-phase-budgets.ts';
import { toReadPollCommand } from '../poll/alm-conformance-poll-commands.ts';
import { PATH_TOPOLOGY } from './to-path-topology-config-command.ts';

/** The page reads its own health, which names its accepted overlay, until that overlay is the path's tree. */
export function toPathInForcePollCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return toReadPollCommand({
        step,
        name: 'tree-in-force',
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
        facts: [{
            name: 'tree-in-force-topology',
            source: { read: 'read', field: 'rallar.formation.accepted.overlay.topology' },
            operator: 'equals',
            expected: PATH_TOPOLOGY.topologyKind
        }]
    });
}
