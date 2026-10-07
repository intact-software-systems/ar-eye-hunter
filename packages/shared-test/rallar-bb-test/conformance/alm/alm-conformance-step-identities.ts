import type { RallarBlackBoxDistributedGroupRef } from '../../distributed-run.ts';
import type { RallarBlackBoxTestRecord } from '../../rallar-black-box-test-contracts.ts';

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

export function toSendHandleId(step: AlmConformanceMessageStepInput): string {
    return `alm-${step.input.carrier}-${step.scenarioKey}-send-${step.index}`;
}

export function toConnectionName(step: AlmConformanceStepInput): string {
    return step.role === 'sender' || step.role === 'successor'
        ? step.input.senderConnection
        : step.input.receiverConnection;
}

export function toRoomRef(group: RallarBlackBoxDistributedGroupRef): RallarBlackBoxTestRecord {
    return {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId
    };
}
