import { AppTopics } from '@shared/api/api-config.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestHttpRequestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../rallar-black-box-test-contracts.ts';

import { RESPONSE_MARGIN_MS, toBudgetMs } from '../alm-conformance-budgets.ts';
import { ALM_INBOUND_DIAGNOSTICS_TOPIC, toDiagnosticWait } from '../alm-conformance-diagnostic-waits.ts';
import { ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES } from '../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toCommandId, toConnectionName } from '../alm-conformance-step-identities.ts';
import { toPauseCommand } from '../to-pause-command.ts';

const PRINCIPAL_WRITE_COUNT = 3;
const PRINCIPAL_WRITE_TIMEOUT_MS = 5_000;
const ORDERING_POSITION = 'ordering-position';

/**
 * The server orders a principal's client-state events on its own producer track. The sender writes its principal
 * three times; the principal's second session, the sibling, reads its first copy as `entered` at prior 0, whatever
 * sequence it carries, and states no `before-entry`. The receiver, another principal's session, hears none of them.
 */
export const serverOrderedEntry: AlmConformanceScenarioDefinition = {
    scenarioId: 'server-ordered-entry',
    scenarioKey: 'server-ordered-entry',
    tags: FULL_TAGS,
    carriers: ['ws'],
    roles: ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES,
    laneFamily: 'same-principal',
    messageSelector: { topicId: AppTopics.clientStateEvent },
    toSenderCommands: (sender) => toPrincipalUpsertCommands(sender, PRINCIPAL_WRITE_COUNT),
    toRecipientCommands: (recipient) =>
        recipient.role === 'sibling' ? toOrderingEntryWait(recipient) : [toNoClientStateEventWait(recipient)]
};

/** Each write settles before the next, so each event leaves the server as its own copy. */
function toPrincipalUpsertCommands(
    sender: AlmConformanceStepInput,
    count: number
): readonly RallarBlackBoxTestCommand[] {
    return Array.from({ length: count }, (_, offset) => offset + 1).flatMap((n) => [
        toPrincipalUpsertCommand(sender, n),
        toPauseCommand(sender, `profile-${n}-settles`, RESPONSE_MARGIN_MS)
    ]);
}

function toPrincipalUpsertCommand(sender: AlmConformanceStepInput, n: number): RallarBlackBoxTestHttpRequestCommand {
    const { applicationId, workspaceId } = sender.input.group;
    const commandId = toCommandId(sender, `profile-${n}`);
    return {
        kind: 'http.request',
        commandId,
        timeoutMs: toBudgetMs(PRINCIPAL_WRITE_TIMEOUT_MS, sender.input.deadlineMs),
        metadata: {
            purpose: 'Write the signed-in principal, so the server publishes a client-state event to its sessions.'
        },
        request: {
            method: 'PUT',
            path: `/api/state/apps/${applicationId}/workspaces/${workspaceId}/clients/{auth.clientId}/principal` +
                `/requests/${commandId}`,
            body: {
                username: '{auth.username}',
                displayName: `server-ordered-entry ${n}`,
                status: 'active',
                roles: ['black-box']
            }
        },
        response: { body: 'json', acceptedStatusCodes: [200, 201] }
    };
}

/** The page's lanes hear `client-state.event` alone on this cell, so the position names no track to scope by. */
function toOrderingEntryWait(sibling: AlmConformanceStepInput): readonly RallarBlackBoxTestWaitCommand[] {
    return [
        toDiagnosticWait({
            step: sibling,
            name: 'entered',
            topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
            payloadFields: { 'data.kind': ORDERING_POSITION, 'data.status': 'entered', 'data.priorSeq': 0 }
        }),
        toDiagnosticWait({
            step: sibling,
            name: 'no-before-entry',
            topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
            payloadFields: { 'data.kind': ORDERING_POSITION, 'data.status': 'before-entry' },
            absent: true
        })
    ];
}

/** The receiver starts before the sender, so its window covers every write of the sender's recipe. */
function toNoClientStateEventWait(receiver: AlmConformanceStepInput): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(receiver, 'no-client-state-event'),
        match: {
            kind: 'message',
            topic: 'rallar.browser.ws.message',
            connection: toConnectionName(receiver),
            payloadFields: { 'data.topicId': AppTopics.clientStateEvent }
        },
        absent: true,
        timeoutMs: receiver.input.deadlineMs - RESPONSE_MARGIN_MS
    };
}
