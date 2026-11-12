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
import { toResultAssertion } from '../alm-conformance-message-commands.ts';
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

/** The entry a page states: on the sender principal's track or on any track, and whether its seq must exceed 1. */
interface AlmOrderingEntry {
    readonly onSenderTrack: boolean;
    readonly aboveFirstSeq: boolean;
}

/**
 * The server orders a principal's client-state events on its own producer track, and a principal's event reaches its
 * own sessions and every co-member's. The sender writes its principal three times.
 * The lane starts the sender last and each recipient only once its connect barrier released
 * (`tests/playwright/rallar-black-box/full-stack-agent-run.ts:103` `runRecipesOnAgents` with `toStartOrder` at :202,
 * `tests/playwright/rallar-black-box/full-stack-helpers.ts:686` `startRecipientRecipeRun`), so the sender principal's
 * track carries at least the sibling's connect event before the sender's own: the sender enters above seq 1, prior 0,
 * the nonzero-entry witness that before Slice 5 read a gap from 1. The exact seq is not the cell's: on one API the
 * track also carries every earlier lane connect of the principal (revision 2 on a fresh API, 41 in a full ws lane run).
 * The sibling, the principal's second session, enters at its first copy, its own connect event at revision 1.
 * The receiver, a co-member of another principal, enters the sender principal's track at its first copy on it.
 * No page states `before-entry` in the window after the last write's copy arrived.
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
    toSenderCommands: (sender) => [
        ...toPrincipalUpsertCommands(sender, PRINCIPAL_WRITE_COUNT),
        ...toOrderingEntryCommands(sender, { onSenderTrack: true, aboveFirstSeq: true })
    ],
    toRecipientCommands: (recipient) =>
        toOrderingEntryCommands(recipient, { onSenderTrack: recipient.role !== 'sibling', aboveFirstSeq: false })
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
 * The page's lanes hear `client-state.event` alone on this cell. A page also enters every co-member principal's
 * track, so an entry on the sender principal's track names it: the ordering key and the server's peer id of the
 * last write's copy, which the page waits for first, so the absence window after it covers every write.
 */
function toOrderingEntryCommands(
    step: AlmConformanceStepInput,
    entry: AlmOrderingEntry
): readonly RallarBlackBoxTestCommand[] {
    const arrival = toLastWriteArrivalWait(step);
    const event = `resultCache.${arrival.commandId}.value.event.payload`;
    return [
        arrival,
        toDiagnosticWait({
            step,
            name: 'entered',
            topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
            ...(entry.onSenderTrack ? { contains: `"trackKey":"{${event}.contextId}:{${event}.senderId}:` } : {}),
            payloadFields: { 'data.kind': ORDERING_POSITION, 'data.status': 'entered', 'data.priorSeq': 0 }
        }),
        ...(entry.aboveFirstSeq
            ? [toResultAssertion({
                step,
                name: 'entered-above-first',
                resultName: 'entered',
                field: 'event.payload.data.seq',
                operator: 'gt',
                expected: 1
            })]
            : []),
        toDiagnosticWait({
            step,
            name: 'no-before-entry',
            topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
            payloadFields: { 'data.kind': ORDERING_POSITION, 'data.status': 'before-entry' },
            absent: true
        })
    ];
}

/** The copy of the sender's last principal write, whose event names the write's request id. */
function toLastWriteArrivalWait(step: AlmConformanceStepInput): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(step, 'last-write-arrived'),
        match: {
            kind: 'message',
            topic: 'rallar.browser.ws.message',
            connection: toConnectionName(step),
            payloadFields: {
                'data.topicId': AppTopics.clientStateEvent,
                'data.payload.principalId': toPrincipalPlaceholder('sender'),
                'data.payload.requestId': toCommandId({ ...step, role: 'sender' }, `profile-${PRINCIPAL_WRITE_COUNT}`)
            }
        },
        timeoutMs: toVerdictTimeoutMs(step.input.deadlineMs)
    };
}
