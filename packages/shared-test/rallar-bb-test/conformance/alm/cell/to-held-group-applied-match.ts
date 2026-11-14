import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type { RallarBlackBoxTestWaitMatch } from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';

/**
 * The page applied the cell's room and holds it: a `held` application of the cell's group, plus the `extra` fields a
 * wait adds to the same event. The bridged diagnostic names no connection, so the match names none.
 */
export function toHeldGroupAppliedMatch(
    step: AlmConformanceStepInput,
    extra: Readonly<Record<string, ApiJsonValue>>
): RallarBlackBoxTestWaitMatch {
    const group = step.input.group;
    return {
        kind: 'diagnostic',
        topic: 'rallar.browser.group_state.applied',
        payloadFields: {
            'data.change': 'held',
            'data.groupRef.applicationId': group.applicationId,
            'data.groupRef.workspaceId': group.workspaceId,
            'data.groupRef.groupId': group.groupId,
            ...extra
        }
    };
}
