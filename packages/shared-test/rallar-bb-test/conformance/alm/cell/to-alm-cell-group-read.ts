import type { RallarBlackBoxTestHttpRequestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { MESSAGE_CONTROL_TIMEOUT_MS, toBudgetMs } from '../alm-conformance-budgets.ts';
import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toCommandId, toRoomRef } from '../alm-conformance-step-identities.ts';

export interface AlmCellGroupReadInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    /** `''` reads the group's snapshot; `/formation` reads its formation view. */
    readonly resource: '' | '/formation';
    readonly purpose: string;
}

/** What the server holds of the cell's group, read under the page's own session. */
export function toAlmCellGroupRead(read: AlmCellGroupReadInput): RallarBlackBoxTestHttpRequestCommand {
    const group = read.step.input.group;
    return {
        kind: 'http.request',
        commandId: toCommandId(read.step, read.name),
        timeoutMs: toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, read.step.input.deadlineMs),
        metadata: {
            purpose: read.purpose,
            idempotent: true,
            group: toRoomRef(group)
        },
        request: {
            method: 'GET',
            path: `/api/state/apps/${group.applicationId}/workspaces/${group.workspaceId}/groups/${group.groupId}` +
                read.resource
        },
        response: { body: 'json', acceptedStatusCodes: [200] }
    };
}
