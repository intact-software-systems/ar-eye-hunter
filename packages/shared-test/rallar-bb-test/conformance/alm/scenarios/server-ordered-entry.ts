import { AppTopics } from '@shared/api/api-config.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestHttpRequestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../rallar-black-box-test-contracts.ts';

import { RESPONSE_MARGIN_MS, toBudgetMs } from '../alm-conformance-budgets.ts';
import {
    ALM_INBOUND_DIAGNOSTICS_TOPIC,
    toDiagnosticWait,
    toVerdictTimeoutMs
} from '../alm-conformance-diagnostic-waits.ts';
import { ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES } from '../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toCommandId, toConnectionName } from '../alm-conformance-step-identities.ts';
import { toPrincipalPlaceholder } from '../resolve-alm-conformance-principals.ts';
import { toPauseCommand } from '../to-pause-command.ts';

const PRINCIPAL_WRITE_COUNT = 3;
const PRINCIPAL_WRITE_TIMEOUT_MS = 5_000;
const ORDERING_POSITION = 'ordering-position';

/**
 * The server orders a principal's client-state events on its own producer track, and a principal's event reaches its
 * own sessions and every co-member's. The sender writes its principal three times.
 * The lane starts the sender after every other connect, so its first copy, its own connect event, is revision 2: it is
 * the nonzero-entry witness, which before Slice 5 read a gap from 1.
 * The sibling, the principal's second session, enters at its first copy, its own connect event at revision 1, and
 * states no `before-entry`.
 * The receiver, a co-member of another principal, enters the sender principal's track at its first copy on it and
 * states no `before-entry`.
 */
export const serverOrderedEntry: AlmConformanceScenarioDefinition = {
    scenarioId: 'server-ordered-entry',
    scenarioKey: 'server-ordered-entry',
    tags: FULL_TAGS,
    carriers: ['ws'],
    roles: ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES,
    laneFamily: 'same-principal',
    messageSelector: { topicId: AppTopics.clientStateEvent },
    principalRoles: ['sender'],
    toSenderCommands: (sender) => toPrincipalUpsertCommands(sender, PRINCIPAL_WRITE_COUNT),
    toRecipientCommands: (recipient) =>
        recipient.role === 'sibling' ? toOrderingEntryWait(recipient, undefined) : toCoMemberEntryWaits(recipient)
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

/**
 * The page's lanes hear `client-state.event` alone on this cell. Absent a track, the entry may be on any principal's
 * track; `before-entry` is absent on every track either way.
 */
function toOrderingEntryWait(
    step: AlmConformanceStepInput,
    track: string | undefined
): readonly RallarBlackBoxTestWaitCommand[] {
    return [
        toDiagnosticWait({
            step,
            name: 'entered',
            topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
            ...(track === undefined ? {} : { contains: `"trackKey":"${track}:` }),
            payloadFields: { 'data.kind': ORDERING_POSITION, 'data.status': 'entered', 'data.priorSeq': 0 }
        }),
        toDiagnosticWait({
            step,
            name: 'no-before-entry',
            topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
            payloadFields: { 'data.kind': ORDERING_POSITION, 'data.status': 'before-entry' },
            absent: true
        })
    ];
}

/**
 * A co-member's page also enters its own principal's track, so its entry wait names the sender principal's track:
 * the ordering key and the server's peer id of an arrival of that principal's event.
 */
function toCoMemberEntryWaits(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestWaitCommand[] {
    const arrival = toSenderPrincipalEventWait(receiver);
    const event = `resultCache.${arrival.commandId}.value.event.payload`;
    return [arrival, ...toOrderingEntryWait(receiver, `{${event}.contextId}:{${event}.senderId}`)];
}

function toSenderPrincipalEventWait(receiver: AlmConformanceStepInput): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(receiver, 'sender-principal-event'),
        match: {
            kind: 'message',
            topic: 'rallar.browser.ws.message',
            connection: toConnectionName(receiver),
            payloadFields: {
                'data.topicId': AppTopics.clientStateEvent,
                'data.payload.principalId': toPrincipalPlaceholder('sender')
            }
        },
        timeoutMs: toVerdictTimeoutMs(receiver.input.deadlineMs)
    };
}
