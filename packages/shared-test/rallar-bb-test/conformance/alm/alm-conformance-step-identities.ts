import type { RallarBlackBoxDistributedGroupRef } from '../../distributed-run.ts';
import type { RallarBlackBoxTestRecord } from '../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceRole } from './alm-conformance-roles.ts';
import type { AlmConformanceMessageStepInput, AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';

/** The product only admits a user WS topic under `app.` or `room.`; the scenario scope stays in the typeId. */
export const ALM_CONFORMANCE_TOPIC_ID = 'room.alm-conformance';

/** A `room.` topic makes any send room-scoped, so the world cell publishes under `app.`. */
export const ALM_CONFORMANCE_WORLD_TOPIC_ID = 'app.alm-conformance.world';

/** The granted topic the lanes' API profiles install; only a session that elected to receive it is sent its messages. */
export const ALM_CONFORMANCE_GRANTED_TOPIC_ID = 'room.alm-conformance-granted';

/** A scenario whose selector is granted publishes and listens on that selector's topic. */
export function toScenarioTopicId(step: AlmConformanceStepInput): string {
    if (step.messageSelector?.access === 'granted') {
        return step.messageSelector.topicId;
    }
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
    return toHandleId(step, step.index);
}

/** A loop's send template: iteration `n` (from 1) names the handle `toSendHandleId` names for index `n`. */
export function toLoopIterationSendHandleId(step: AlmConformanceStepInput): string {
    return toHandleId(step, '{loop.iteration}');
}

/** A responder's reply to the `step.index`-th arrival names its role, so the reply handles of a cell stay apart. */
export function toReplyHandleId(step: AlmConformanceMessageStepInput): string {
    return `alm-${step.input.carrier}-${step.scenarioKey}-${step.role}-reply-${step.index}`;
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

function toHandleId(step: AlmConformanceStepInput, index: number | string): string {
    const origin = isSenderPage(step.role) ? '' : `${step.role}-`;
    return `alm-${step.input.carrier}-${step.scenarioKey}-${origin}send-${index}`;
}

/**
 * The successor is a second page of the sender's session: it shares the sender's connection and its handles.
 * `publisher-b` produces too, but on an agent of its own, so its handles name its role as a recipient's do.
 */
function isSenderPage(role: AlmConformanceRole): boolean {
    return role === 'sender' || role === 'successor';
}
