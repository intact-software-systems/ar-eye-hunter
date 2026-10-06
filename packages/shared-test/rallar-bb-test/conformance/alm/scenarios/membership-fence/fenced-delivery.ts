import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestHttpRequestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { MESSAGE_CONTROL_TIMEOUT_MS, NON_EXPIRING_TTL_MS, toBudgetMs } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_SINGLE_HOP_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toAudienceSendCommands } from '../../alm-conformance-receipt-commands.ts';
import { toSingleArrivalReceiverCommands } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toCommandId, toRoomRef, toScenarioTypeId } from '../../alm-conformance-step-identities.ts';

/**
 * A member's room send carries the roster of its sender's room snapshot and reaches both recipients. Nothing moves the
 * roster inside the cell, so each recipient reads the group's roster from the server after the arrival and finds it
 * on the delivered message.
 */
export const fencedDelivery: AlmConformanceScenarioDefinition = {
    scenarioId: 'fenced-delivery',
    scenarioKey: 'fenced-delivery',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_SINGLE_HOP_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toSenderCommands: (sender) => toAudienceSendCommands({ sender, ttlMs: NON_EXPIRING_TTL_MS }),
    toRecipientCommands: toFencedDeliveryRecipientCommands
};

function toFencedDeliveryRecipientCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const [received, absentSecond] = toSingleArrivalReceiverCommands(recipient);
    return [received, toRosterReadCommand(recipient), toRosterStampWait(recipient), absentSecond];
}

/** The group snapshot the server holds; its `body.group.rosterVersion` is the roster the delivered send must carry. */
function toRosterReadCommand(recipient: AlmConformanceStepInput): RallarBlackBoxTestHttpRequestCommand {
    const group = recipient.input.group;
    return {
        kind: 'http.request',
        commandId: toCommandId(recipient, 'read-roster'),
        timeoutMs: toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, recipient.input.deadlineMs),
        metadata: {
            purpose: 'Read the group roster version the server holds.',
            idempotent: true,
            group: toRoomRef(group)
        },
        request: {
            method: 'GET',
            path: `/api/state/apps/${group.applicationId}/workspaces/${group.workspaceId}/groups/${group.groupId}`
        },
        response: { body: 'json', acceptedStatusCodes: [200] }
    };
}

/**
 * An arrival of the cell's type whose room target carried the roster the read returned. The received event states
 * `rosterVersion` right after the type id, so one match names both; the arrival is already counted, so the wait spends
 * no send budget.
 */
function toRosterStampWait(recipient: AlmConformanceStepInput): RallarBlackBoxTestWaitCommand {
    const roster = `{resultCache.${toCommandId(recipient, 'read-roster')}.value.body.group.rosterVersion}`;
    return {
        kind: 'wait',
        commandId: toCommandId(recipient, 'roster-stamp'),
        match: {
            kind: 'message',
            connection: recipient.input.receiverConnection,
            payloadPath: 'data',
            contains: `"typeId":"${toScenarioTypeId(recipient)}","rosterVersion":${roster},`
        },
        timeoutMs: toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, recipient.input.deadlineMs)
    };
}
