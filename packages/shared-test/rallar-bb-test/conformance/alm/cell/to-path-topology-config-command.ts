import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';
import { SUBSCRIPTION_COMMAND_TIMEOUT_MS } from '../granted-topic/subscription-phase-budgets.ts';
import { toAlmCellGroupPath } from './to-alm-cell-group-read.ts';
import { toAlmCellRequestIdSuffix } from './to-alm-cell-request-id.ts';

/** Three sessions in a tree whose degree is at most two form a path; `meshParamK` may not exceed the degree limit. */
export const PATH_TOPOLOGY = { topologyKind: 'tree', degreeLimit: 2, meshParamK: 2 } as const;

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
