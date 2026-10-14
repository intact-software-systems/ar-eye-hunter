import type { RallarBlackBoxDistributedGroupRef } from '../../distributed-run.ts';
import type { RallarBlackBoxTestRecord } from '../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceRole } from './alm-conformance-roles.ts';
import type { AlmConformanceMessageStepInput, AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';

/** The product only admits a user WS topic under `app.` or `room.`; the scenario scope stays in the typeId. */
export const ALM_CONFORMANCE_TOPIC_ID = 'room.alm-conformance';

/** A `room.` topic makes any send room-scoped, so the world cell publishes under `app.`. */
export const ALM_CONFORMANCE_WORLD_TOPIC_ID = 'app.alm-conformance.world';

export function toScenarioTopicId(step: AlmConformanceStepInput): string {
    return step.scenarioId === 'world-routing' ? ALM_CONFORMANCE_WORLD_TOPIC_ID : ALM_CONFORMANCE_TOPIC_ID;
}

export function toScenarioTypeId(step: AlmConformanceStepInput): string {
    return `${step.input.typeId}.${step.input.carrier}.${step.scenarioKey}`;
}

export function toCommandId(step: AlmConformanceStepInput, name: string): string {
    return `alm-${step.input.carrier}-${step.scenarioKey}-${step.role}-${name}`;
}

/** A recipient's own send names its role, so no handle of a cell names two sends. */
export function toSendHandleId(step: AlmConformanceMessageStepInput): string {
    const origin = isSenderPage(step.role) ? '' : `${step.role}-`;
    return `alm-${step.input.carrier}-${step.scenarioKey}-${origin}send-${step.index}`;
}

export function toConnectionName(step: AlmConformanceStepInput): string {
    return isSenderPage(step.role) ? step.input.senderConnection : step.input.receiverConnection;
}

export function toRoomRef(group: RallarBlackBoxDistributedGroupRef): RallarBlackBoxTestRecord {
    return {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId
    };
}

/** The successor is a second page of the sender's session: it shares the sender's connection and its handles. */
function isSenderPage(role: AlmConformanceRole): boolean {
    return role === 'sender' || role === 'successor';
}
