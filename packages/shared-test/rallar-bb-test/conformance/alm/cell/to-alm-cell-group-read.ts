import type { RallarBlackBoxTestHttpRequestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { MESSAGE_CONTROL_TIMEOUT_MS, toBudgetMs } from '../alm-conformance-budgets.ts';
import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toCommandId, toRoomRef } from '../alm-conformance-step-identities.ts';

interface AlmCellGroupReadInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    /** The group's snapshot, or its formation view. */
    readonly resource: 'snapshot' | 'formation';
    readonly purpose: string;
}

/** The REST path of the cell's room, which every owner and member request extends. */
export function toAlmCellGroupPath(step: AlmConformanceStepInput): string {
    const group = step.input.group;
    return `/api/state/apps/${group.applicationId}/workspaces/${group.workspaceId}/groups/${group.groupId}`;
}

/** What the server holds of the cell's group, read under the page's own session. */
export function toAlmCellGroupRead(read: AlmCellGroupReadInput): RallarBlackBoxTestHttpRequestCommand {
    const path = toAlmCellGroupPath(read.step);
    return {
        kind: 'http.request',
        commandId: toCommandId(read.step, read.name),
        timeoutMs: toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, read.step.input.deadlineMs),
        metadata: {
            purpose: read.purpose,
            idempotent: true,
            group: toRoomRef(read.step.input.group)
        },
        request: {
            method: 'GET',
            path: read.resource === 'snapshot' ? path : `${path}/formation`
        },
        response: { body: 'json', acceptedStatusCodes: [200] }
    };
}
