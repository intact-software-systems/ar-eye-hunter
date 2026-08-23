import type {
    GroupJoinCodeWritten,
    GroupStateWritten
} from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import {
    type GroupJoinCodeMutationWritten,
    type GroupMutationWritten
} from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import {
    requireGroupJoinCodeWritten,
    requireGroupPresenceInboxDurableResult,
    requireGroupStateWritten
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result-codec.ts';
import type {
    GroupPresenceInboxDurableResult,
    GroupStateInboxDurableResult
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts';
import {
    GroupMutationRejectedError
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import type { GroupStateRouteService } from './group-state-route-contracts.ts';

type GroupJoinCodeResponse = Omit<GroupJoinCodeMutationWritten, 'event'>;

export type GroupStateResponseInput =
    | Readonly<{
        kind: 'mutation';
        written: GroupStateInboxDurableResult;
    }>
    | Readonly<{
        kind: 'join-code';
        written: GroupStateInboxDurableResult;
    }>
    | Readonly<{
        kind: 'presence';
        receipt: GroupStateInboxDurableResult;
        ref: GroupRef;
        service: GroupStateRouteService;
    }>;

export function toGroupStateResponse(
    input: Extract<GroupStateResponseInput, { kind: 'mutation'; }>
): GroupMutationWritten;

export function toGroupStateResponse(
    input: Extract<GroupStateResponseInput, { kind: 'join-code'; }>
): GroupJoinCodeResponse;

export function toGroupStateResponse(
    input: Extract<GroupStateResponseInput, { kind: 'presence'; }>
): Promise<GroupSnapshot>;

export function toGroupStateResponse(
    input: GroupStateResponseInput
): GroupMutationWritten | GroupJoinCodeResponse | Promise<GroupSnapshot> {
    switch (input.kind) {
        case 'mutation':
            return toGroupMutationResponse(requireGroupStateWritten(input.written));
        case 'join-code':
            return toGroupJoinCodeResponse(requireGroupJoinCodeWritten(input.written));
        case 'presence':
            return toGroupPresenceResponse({
                ...input,
                receipt: requireGroupPresenceInboxDurableResult(input.receipt)
            });
    }
}

function toGroupMutationResponse(written: GroupStateWritten): GroupMutationWritten {
    return written.result;
}

function toGroupJoinCodeResponse(written: GroupJoinCodeWritten): GroupJoinCodeResponse {
    const { event: _event, ...response } = written.result;
    return response;
}

async function toGroupPresenceResponse(
    input: Omit<Extract<GroupStateResponseInput, { kind: 'presence'; }>, 'receipt'> & {
        readonly receipt: GroupPresenceInboxDurableResult;
    }
): Promise<GroupSnapshot> {
    if ('commandId' in input.receipt && input.receipt.outcome === 'rejected') {
        throw new GroupMutationRejectedError(
            input.receipt.rejection ?? 'Group presence mutation rejected'
        );
    }

    const snapshot = await input.service.readCurrentSnapshot(input.ref);
    if (!snapshot) {
        throw new Error(`Group snapshot not found after mutation: ${input.ref.groupId}`);
    }

    return snapshot;
}
