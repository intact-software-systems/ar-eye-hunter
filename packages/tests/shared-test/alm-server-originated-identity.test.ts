import { describe, expect, it } from 'vitest';

import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { RecordedAlmConformanceParticipant } from '@shared-test/rallar-bb-test/conformance/alm/identity/assess-alm-conformance-identity.ts';
import { assessAlmServerOriginatedIdentity } from '@shared-test/rallar-bb-test/conformance/alm/identity/assess-alm-server-originated-identity.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const PREFIX = 'alm-ws-server-originated';
const LEAVE = `${PREFIX}-sender-leave-traced`;
const REJOIN = `${PREFIX}-sender-rejoin-traced`;
const TRACE_LEFT = `${PREFIX}-sender-trace-left`;
const TRACE_ACTIVE = `${PREFIX}-sender-trace-active`;
const DELTA_LEFT = `${PREFIX}-receiver-delta-trace-left`;
const ADMIN_READ = `${PREFIX}-receiver-read-admin-realtime`;
const RECEIVER_SESSION = 'receiver-session';

/** Recorded results keyed by command id, each value what a passing cell records for it. */
class RecordedCell {
    readonly sender: RecipeEvidence;
    readonly receiver: RecipeEvidence;

    constructor() {
        const scenario = createAlmConformanceRecipes(toConformanceInput('ws'))
            .find(({ scenarioId }) => scenarioId === 'server-originated')!;
        this.sender = new RecipeEvidence('sender', scenario.sender);
        this.receiver = new RecipeEvidence('receiver', scenario.receiver);
    }

    assess(): readonly string[] {
        return assessAlmServerOriginatedIdentity({ sender: this.sender.recorded(), receiver: this.receiver.recorded() });
    }
}

class RecipeEvidence {
    readonly role: string;
    readonly commands: RallarBlackBoxTestCommand[];
    readonly values = new Map<string, ApiJsonObject>();

    constructor(role: string, recipe: RallarBlackBoxTestRecipe) {
        this.role = role;
        this.commands = [...recipe.commands];
        for (const command of this.commands) {
            this.values.set(command.commandId!, toPassingValue(command, role));
        }
    }

    value(commandId: string): ApiJsonObject {
        return this.values.get(commandId)!;
    }

    recorded(): RecordedAlmConformanceParticipant {
        const results = new Map<string, RallarBlackBoxTestResult>(this.commands.map((command) => [
            command.commandId!,
            {
                commandId: command.commandId!,
                kind: command.kind,
                ok: true,
                status: 'ok',
                startedAtEpochMs: 1,
                endedAtEpochMs: 2,
                durationMs: 1,
                value: this.values.get(command.commandId!)
            }
        ]));
        const recipe: RallarBlackBoxTestRecipe = { schemaVersion: 1, recipeId: `${PREFIX}-${this.role}`, commands: this.commands };
        return { participant: { role: this.role, agentId: this.role, commandId: `${this.role}-root`, recipe, result: undefined }, results };
    }
}

function toPassingValue(command: RallarBlackBoxTestCommand, role: string): ApiJsonObject {
    if (command.kind === 'rtc.connect') {
        return { sessionId: `${role}-session` };
    }
    const traceId = command.kind === 'http.request' ? command.request.headers?.['x-request-id'] : undefined;
    if (traceId !== undefined) {
        return { status: 200, headers: { 'x-request-id': traceId } };
    }
    const deltaTrace = command.kind === 'wait' ? command.match.payloadFields?.['data.traceId'] : undefined;
    if (typeof deltaTrace === 'string') {
        return toDelta(deltaTrace, {});
    }
    if (command.commandId === ADMIN_READ) {
        return { status: 200, body: toAdminBody([toEntry(TRACE_LEFT, [RECEIVER_SESSION]), toEntry(TRACE_ACTIVE, [RECEIVER_SESSION])]) };
    }
    return {};
}

/** A matched delta wait's value; `data` overrides the fields a defect rewrites. */
function toDelta(traceId: string, data: ApiJsonObject): ApiJsonObject {
    const delta = { msgId: `delta:${traceId}`, traceId, payload: { event: { traceId } } };
    return { matched: true, event: { payload: { data: { ...delta, ...data } } } };
}

function toEntry(traceId: string, confirmedPeerIds: readonly string[]): ApiJsonObject {
    return { msgId: `delta:${traceId}`, traceId, confirmedPeerIds: [...confirmedPeerIds], lastSettlementKind: 'acknowledgement' };
}

function toAdminBody(messages: readonly ApiJsonObject[]): ApiJsonObject {
    return { almReceipts: { processLocal: true, diagnostics: { capacity: 256, messages: [...messages] } } };
}

const DELTA_ISSUE = `${LEAVE}: the receiver's delta does not carry the request trace.`;
const ONE_WAIT_ISSUE = `${LEAVE}: exactly one authored receiver wait must name the request trace.`;
const ADMIN_ISSUE = `${REJOIN}: the receiver's admin read lists no receipt of the trace it confirmed.`;

describe('ALM server-originated identity assessment', () => {
    it('joins each traced request to its echo, its one delta and the admin receipt the receiver confirmed', () => {
        expect(new RecordedCell().assess()).toEqual([]);
    });

    it.each(
        [
            ['the response echoes another trace', (cell: RecordedCell) => {
                cell.sender.values.set(REJOIN, { status: 200, headers: { 'x-request-id': 'trace-other' } });
            }, `${REJOIN}: the response does not echo the request trace.`],
            ['the response echoes no trace', (cell: RecordedCell) => {
                cell.sender.values.set(REJOIN, { status: 200, headers: {} });
            }, `${REJOIN}: the response does not echo the request trace.`],
            ['the delta envelope carries another trace', (cell: RecordedCell) => {
                cell.receiver.values.set(DELTA_LEFT, toDelta(TRACE_LEFT, { traceId: 'trace-other' }));
            }, DELTA_ISSUE],
            ['the delta event carries another trace', (cell: RecordedCell) => {
                cell.receiver.values.set(DELTA_LEFT, toDelta(TRACE_LEFT, { payload: { event: { traceId: 'trace-other' } } }));
            }, DELTA_ISSUE],
            ['the delta has no message id', (cell: RecordedCell) => {
                cell.receiver.values.set(DELTA_LEFT, toDelta(TRACE_LEFT, { msgId: '' }));
            }, DELTA_ISSUE],
            ['the wait did not match', (cell: RecordedCell) => {
                cell.receiver.values.set(DELTA_LEFT, { ...toDelta(TRACE_LEFT, {}), matched: false });
            }, DELTA_ISSUE],
            ['no receiver wait names the trace', (cell: RecordedCell) => {
                cell.receiver.commands.splice(cell.receiver.commands.findIndex(({ commandId }) => commandId === DELTA_LEFT), 1);
            }, ONE_WAIT_ISSUE],
            ['two receiver waits name the trace', (cell: RecordedCell) => {
                const wait = cell.receiver.commands.find(({ commandId }) => commandId === DELTA_LEFT)!;
                cell.receiver.commands.push({ ...wait, commandId: `${DELTA_LEFT}-again` });
                cell.receiver.values.set(`${DELTA_LEFT}-again`, cell.receiver.value(DELTA_LEFT));
            }, ONE_WAIT_ISSUE],
            ['the admin read lists no receipt', (cell: RecordedCell) => {
                cell.receiver.values.set(ADMIN_READ, { status: 200, body: toAdminBody([]) });
            }, ADMIN_ISSUE],
            ['the last trace\'s receipt is confirmed by another session only', (cell: RecordedCell) => {
                cell.receiver.values.set(ADMIN_READ, {
                    status: 200,
                    body: toAdminBody([toEntry(TRACE_LEFT, [RECEIVER_SESSION]), toEntry(TRACE_ACTIVE, ['sender-session'])])
                });
            }, ADMIN_ISSUE],
            ['only the first trace has a receipt', (cell: RecordedCell) => {
                cell.receiver.values.set(ADMIN_READ, { status: 200, body: toAdminBody([toEntry(TRACE_LEFT, [RECEIVER_SESSION])]) });
            }, ADMIN_ISSUE]
        ] as const
    )('raises one named issue when %s', (_defect, apply, issue) => {
        const cell = new RecordedCell();
        apply(cell);
        expect(cell.assess()).toEqual([issue]);
    });

    it('raises nothing for a sender that sends no traced request', () => {
        const cell = new RecordedCell();
        cell.sender.commands.splice(
            0,
            cell.sender.commands.length,
            ...cell.sender.commands.filter((command) => command.kind !== 'http.request' || command.request.headers === undefined)
        );
        expect(cell.assess()).toEqual([]);
    });
});
