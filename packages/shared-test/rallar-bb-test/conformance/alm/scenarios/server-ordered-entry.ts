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
import { toAlmCellRequestId, toAlmCellRequestIdSuffix } from '../cell/to-alm-cell-request-id.ts';
import { toPrincipalPlaceholder } from '../resolve-alm-conformance-principals.ts';
import { toPauseCommand } from '../to-pause-command.ts';

const PRINCIPAL_WRITE_COUNT = 3;
const PRINCIPAL_WRITE_TIMEOUT_MS = 5_000;
const ORDERING_POSITION = 'ordering-position';

/**
 * The server orders a principal's client-state events on its own producer track, and a principal's event reaches its
 * own sessions and every co-member's. The sender writes its principal three times.
 * The lane starts the sender last and each recipient only once its connect barrier released
 * (`tests/playwright/rallar-black-box/full-stack-agent-run.ts:104` `runRecipesOnAgents` with `toStartOrder` at :203,
 * `tests/playwright/rallar-black-box/full-stack-helpers.ts:706` `startRecipientRecipeRun`), so the sender principal's
 * track carries at least the sibling's connect event before the sender's own: the sender enters above seq 1, prior 0,
 * the nonzero-entry witness that before Slice 5 read a gap from 1. The exact seq is not the cell's: on one API the
 * track also carries every earlier lane connect of the principal.
 * The sibling, the principal's second session, enters the same track at its first copy, its own connect event.
 * The receiver, a co-member of another principal, enters the sender principal's track at its first copy on it.
 * A page enters the track once per connection, so the cell runs in a room of its own, which every page connects to
 * afresh: each entry wait reads its own cell's history and shows that this cell's connects produced the entry. No page
 * states `before-entry` in the window after the last write's copy arrived.
 */
export const serverOrderedEntry: AlmConformanceScenarioDefinition = {
    scenarioId: 'server-ordered-entry',
    scenarioKey: 'server-ordered-entry',
    tags: FULL_TAGS,
    carriers: ['ws'],
    roles: ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES,
    laneFamily: 'same-principal',
    room: 'own',
    messageSelector: { topicId: AppTopics.clientStateEvent },
    principalRoles: ['sender'],
    toSenderCommands: (sender) => [
        ...toPrincipalUpsertCommands(sender, PRINCIPAL_WRITE_COUNT),
        ...toOrderingEntryCommands({ step: sender, aboveFirstSeq: true })
    ],
    toRecipientCommands: (recipient) => toOrderingEntryCommands({ step: recipient, aboveFirstSeq: false })
};

interface OrderingEntryInput {
    readonly step: AlmConformanceStepInput;
    /** The sender also asserts that it entered above seq 1, past the sibling's connect event. */
    readonly aboveFirstSeq: boolean;
}

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
    return {
        kind: 'http.request',
        commandId: toCommandId(sender, `profile-${n}`),
        timeoutMs: toBudgetMs(PRINCIPAL_WRITE_TIMEOUT_MS, sender.input.deadlineMs),
        metadata: {
            purpose: 'Write the signed-in principal, so the server publishes a client-state event to its sessions.'
        },
        request: {
            method: 'PUT',
            path: `/api/state/apps/${applicationId}/workspaces/${workspaceId}/clients/{auth.clientId}/principal` +
                `/requests/${toAlmCellRequestId(sender, toPrincipalWriteName(n))}`,
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

function toPrincipalWriteName(n: number): string {
    return `profile-${n}`;
}

/**
 * The page's lanes hear `client-state.event` alone on this cell. A page also enters every co-member principal's
 * track, so an entry on the sender principal's track names it: the ordering key and the server's peer id of the
 * last write's copy, which the page waits for first, so the absence window after it covers every write.
 */
function toOrderingEntryCommands({ step, aboveFirstSeq }: OrderingEntryInput): readonly RallarBlackBoxTestCommand[] {
    const arrival = toLastWriteArrivalWait(step);
    const event = `resultCache.${arrival.commandId}.value.event.payload`;
    return [
        arrival,
        toDiagnosticWait({
            step,
            name: 'entered',
            topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
            contains: `"trackKey":"{${event}.contextId}:{${event}.senderId}:`,
            payloadFields: { 'data.kind': ORDERING_POSITION, 'data.status': 'entered', 'data.priorSeq': 0 },
            historyFrom: 'cell'
        }),
        ...(aboveFirstSeq
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
            historyFrom: 'cell',
            payloadFields: { 'data.kind': ORDERING_POSITION, 'data.status': 'before-entry' },
            absent: true
        })
    ];
}

/**
 * The copy of the sender's last principal write, whose event names the write's request id. Every page's copy carries
 * the writer page's runtime identity, so a page names the write by the id's sender part; the wait contract has no
 * anchored text operator, so the part is matched by `contains`.
 */
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
                'data.payload.principalId': toPrincipalPlaceholder('sender')
            },
            payloadPath: 'data.payload.requestId',
            contains: toAlmCellRequestIdSuffix({ ...step, role: 'sender' }, toPrincipalWriteName(PRINCIPAL_WRITE_COUNT))
        },
        timeoutMs: toVerdictTimeoutMs(step.input.deadlineMs)
    };
}
