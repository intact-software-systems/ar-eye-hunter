import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import { toAlmCellGroupPath } from '../../cell/to-alm-cell-group-read.ts';
import { toAlmCellRequestIdSuffix } from '../../cell/to-alm-cell-request-id.ts';
import {
    SUBSCRIPTION_COMMAND_TIMEOUT_MS,
    SUBSCRIPTION_PHASE_MS
} from '../../granted-topic/subscription-phase-budgets.ts';
import { toReadPollCommand } from '../../poll/alm-conformance-poll-commands.ts';

/** Three sessions in a tree whose degree is at most two form a path; `meshParamK` may not exceed the degree limit. */
const PATH_TOPOLOGY = { topologyKind: 'tree', degreeLimit: 2, meshParamK: 2 } as const;

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

/** `tree` writes the path's config through the owner's topology route; `reset` deletes it, restoring the defaults. */
export function toPathTopologyConfigCommand(
    owner: AlmConformanceStepInput,
    change: 'tree' | 'reset'
): RallarBlackBoxTestCommand {
    const name = `topology-${change}`;
    return {
        kind: 'http.request',
        commandId: toCommandId(owner, name),
        timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
        request: {
            method: change === 'tree' ? 'PUT' : 'DELETE',
            path: `${toAlmCellGroupPath(owner)}/topology/config/requests/` +
                `alm-topology-{runtimeIdentity}${toAlmCellRequestIdSuffix(owner, name)}`,
            ...(change === 'tree' ? { body: { config: PATH_TOPOLOGY } } : {})
        },
        response: { body: 'json', acceptedStatusCodes: [200] },
        metadata: { purpose: `The room owner's ${change} of the room's topology config.` }
    };
}
