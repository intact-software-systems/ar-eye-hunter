import type { GroupMove } from '@shared/api/mutation/group-move.ts';

import type { AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { AppOutboxType } from '../../app-outbox/app-outbox-type.ts';
import { computeAppOutboxSignal } from '../../app-outbox/compute-app-outbox-signal.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import {
    computeViewInvalidationPublication,
    type ViewInvalidationPublication
} from '../../websocket/outbox/compute-view-invalidation-publication.ts';

import {
    groupMoveDeadlineDueAt,
    toGroupMoveDeadline,
    toGroupMoveDeadlineRoute,
    type GroupMoveDeadline,
    type GroupMoveHistoryDeadline
} from './group-move-deadline.ts';

interface GroupMovePublicationFacts {
    readonly createdAtEpochMs: number;
    readonly retentionMs: number;
    readonly serviceId: string;
    readonly traceId: string;
}

export interface GroupMovePublicationInput extends GroupMovePublicationFacts {
    readonly move: GroupMove;
    readonly revision: number;
    readonly previousStatus: GroupMove['status'] | null;
}

export function computeGroupMovePublication(input: GroupMovePublicationInput): ViewInvalidationPublication {
    const { move } = input;
    const claim = { source: move.source, moveId: move.moveId };
    const changes = computeViewInvalidationPublication({
        ...input,
        resource: 'room-move',
        scope: { applicationId: move.source.applicationId, workspaceId: move.source.workspaceId },
        principalIds: move.participants.map((participant) => participant.principalId),
        changeId: computeSha256CanonicalJson({
            kind: 'transition',
            claim,
            moveCreatedAtEpochMs: move.createdAtEpochMs,
            revision: input.revision
        })
    });
    const deadline = toGroupMoveDeadline(move, input.previousStatus, input.retentionMs);
    return deadline === null
        ? changes
        : { ...changes, outbox: [...changes.outbox, computeMoveDeadline(input, deadline)] };
}

export function computeGroupMoveHistoryPublication(
    command: GroupMoveHistoryDeadline,
    facts: GroupMovePublicationFacts
): ViewInvalidationPublication {
    // The retained command, not a possibly reused move ID, owns this historical audience.
    return computeViewInvalidationPublication({
        ...facts,
        resource: 'room-move',
        scope: { applicationId: command.source.applicationId, workspaceId: command.source.workspaceId },
        principalIds: command.principalIds,
        changeId: computeSha256CanonicalJson(command)
    });
}

function computeMoveDeadline(input: GroupMovePublicationFacts, deadline: GroupMoveDeadline): AppOutboxInsert {
    const dueAtEpochMs = groupMoveDeadlineDueAt(deadline);
    return computeAppOutboxSignal({
        ...toGroupMoveDeadlineRoute(deadline),
        typeId: AppOutboxType.GROUP_MOVE_DEADLINE,
        resource: JSON.stringify(deadline),
        createdAtEpochMs: input.createdAtEpochMs,
        dueAtEpochMs,
        expiresAtEpochMs: dueAtEpochMs + input.retentionMs,
        serviceId: input.serviceId,
        traceId: input.traceId
    });
}
