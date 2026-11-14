import {
    describe,
    expect,
    it
} from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { AlmConformanceRole } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import { toCellHistoryMarkedCommands } from '@shared-test/rallar-bb-test/conformance/alm/cell/to-cell-history-marked-commands.ts';
import {
    createAlmConformanceRecipes,
    createAlmDeliveryDiagnosticsRecipes,
    toAlmConformanceRoleRecipe
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestWaitCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';
import { toWaitCommands } from './to-wait-commands.ts';

/**
 * The one class of wait that reads the page's history: a store's recovery that a fresh document (a successor page, or
 * the page after `agent.reload`) reports during its first connect, before that connect's result opens the cell's mark.
 */
const FRESH_DOCUMENT_RECOVERY_WAITS = [
    'durable-takeover-successor-recovered-original-store',
    'flush-on-hide-successor-recovered-checkpoint-store',
    'delivery-reload-sender-recovered-session-inbound',
    'delivery-reload-sender-recovered-original-store'
] as const;

/** A page enters a principal's server-ordered track once, at its first copy, in whichever cell of the family that was. */
const PRINCIPAL_TRACK_ENTRY_WAITS = [
    'server-ordered-entry-sender-entered',
    'server-ordered-entry-receiver-entered',
    'server-ordered-entry-sibling-entered'
] as const;

const PAGE_HISTORY_WAITS = [...FRESH_DOCUMENT_RECOVERY_WAITS, ...PRINCIPAL_TRACK_ENTRY_WAITS] as const;

const SESSION_PIN_PATTERN = /\{resultCache\.([^}]+)\.value\.sessionId\}/;

/**
 * The wait pins its store to the session of its fresh document's first connect: a successor's first `rtc.connect`, or
 * the first `rtc.connect` after the last `agent.reload` before the wait.
 */
function expectFreshDocumentRecovery(
    recipe: RallarBlackBoxTestRecipe,
    role: AlmConformanceRole,
    wait: RallarBlackBoxTestWaitCommand
): void {
    const commands = recipe.commands;
    const connectId = SESSION_PIN_PATTERN.exec(wait.match.contains ?? '')?.[1];
    const waitAt = commands.indexOf(wait);
    const reloadAt = commands.slice(0, waitAt).findLastIndex((command) => command.kind === 'agent.reload');
    const documentStart = role === 'successor' ? 0 : reloadAt + 1;
    const firstConnect = commands.slice(documentStart, waitAt).find((command) => command.kind === 'rtc.connect');

    expect(wait.match.topic, wait.commandId).toBe('rallar.browser.alm.storage');
    expect(wait.match.contains, wait.commandId).toContain('"kind":"recovery","storeId":"');
    expect(role === 'successor' || reloadAt >= 0, wait.commandId).toBe(true);
    expect(firstConnect?.commandId, wait.commandId).toBeDefined();
    expect(connectId, wait.commandId).toBe(firstConnect?.commandId);
}

/** The wait names the entry at prior 0 on the track of the arrival it read, so no other track's entry can match it. */
function expectPrincipalTrackEntry(wait: RallarBlackBoxTestWaitCommand): void {
    expect(wait.match.topic, wait.commandId).toBe('rallar.browser.alm.inbound_diagnostics');
    expect(wait.match.payloadFields, wait.commandId).toEqual({
        'data.kind': 'ordering-position',
        'data.status': 'entered',
        'data.priorSeq': 0
    });
    expect(wait.match.contains, wait.commandId).toMatch(/^"trackKey":"\{resultCache\.[^}]+\.contextId\}:\{resultCache\.[^}]+\.senderId\}:$/);
}

/** An `entered` wait on a track the cell does not key may only read the page's history, since the page entered it once. */
function isFirstContactOutsideTheCell(wait: RallarBlackBoxTestWaitCommand, scenarioKey: string): boolean {
    const fields = wait.match.payloadFields ?? {};
    const entry = fields['data.kind'] === 'ordering-position' && fields['data.status'] === 'entered';
    return entry && wait.match.contains?.startsWith(`"trackKey":"${scenarioKey}:`) !== true;
}

describe('alm-conformance cell parts', () => {
    it('a body wait cannot start its history at another cell\'s command', () => {
        const step = {
            input: toConformanceInput('rtc'),
            scenarioId: 'delivery-baseline',
            scenarioKey: 'probe',
            role: 'sender',
            roles: ['sender', 'receiver'],
            messages: {},
            connect: undefined
        } as const;
        const toWaitFrom = (sinceCommandIdPrefix: string): RallarBlackBoxTestWaitCommand => ({
            kind: 'wait',
            commandId: 'alm-rtc-probe-sender-late',
            match: { kind: 'diagnostic', topic: 'rallar.browser.group_state.applied', sinceCommandIdPrefix },
            timeoutMs: 1_000
        });

        for (const own of ['alm-rtc-probe-sender-', 'alm-rtc-probe-receiver-armed']) {
            expect(toCellHistoryMarkedCommands(step, [toWaitFrom(own)]), own).toEqual([toWaitFrom(own)]);
        }
        for (const foreign of ['alm-rtc-other-sender-', 'alm-rtc-probe2-sender-', 'alm-ws-probe-sender-', 'sender-']) {
            expect(() => toCellHistoryMarkedCommands(step, [toWaitFrom(foreign)]), foreign)
                .toThrow('alm-rtc-probe-sender-late');
            expect(
                () =>
                    toCellHistoryMarkedCommands(step, [
                        { kind: 'loop', commandId: 'alm-rtc-probe-sender-loop', commands: [toWaitFrom(foreign)] } as RallarBlackBoxTestCommand
                    ]),
                `${foreign} nested`
            ).toThrow('alm-rtc-probe-sender-late');
        }
    });

    it('a body wait cannot start its history at a command of a cell whose key merely begins with its own', () => {
        const step = {
            input: toConformanceInput('rtc'),
            scenarioId: 'delivery-baseline',
            scenarioKey: 'capacity',
            role: 'sender',
            roles: ['sender', 'receiver'],
            messages: {},
            connect: undefined
        } as const;
        const toWaitFrom = (sinceCommandIdPrefix: string): RallarBlackBoxTestWaitCommand => ({
            kind: 'wait',
            commandId: 'alm-rtc-capacity-sender-late',
            match: { kind: 'diagnostic', topic: 'rallar.browser.group_state.applied', sinceCommandIdPrefix },
            timeoutMs: 1_000
        });

        for (const lookAlike of ['alm-rtc-capacity-age-sender-armed', 'alm-rtc-capacity-tracks-receiver-', 'alm-rtc-capacity-age-']) {
            expect(() => toCellHistoryMarkedCommands(step, [toWaitFrom(lookAlike)]), lookAlike).toThrow(
                `Wait alm-rtc-capacity-sender-late of cell alm-rtc-capacity starts its history at ${lookAlike}, ` +
                    'which is not a command of its own cell.'
            );
        }
        for (const own of ['alm-rtc-capacity-sender-', 'alm-rtc-capacity-receiver-armed']) {
            expect(toCellHistoryMarkedCommands(step, [toWaitFrom(own)]), own).toEqual([toWaitFrom(own)]);
        }
    });

    it('every wait of every role\'s body and continuation, on every carrier, reads from its own cell\'s command prefix', () => {
        const pageHistoryWaits: string[] = [];
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(toConformanceInput(carrier))) {
                const cellPrefix = `alm-${carrier}-${scenario.scenarioKey}`;
                for (const role of scenario.roles) {
                    for (const wait of toWaitCommands(scenario.partsByRole[role]!.body)) {
                        if (wait.metadata?.historyFrom === 'page') {
                            const name = wait.commandId!.slice(`alm-${carrier}-`.length);
                            pageHistoryWaits.push(name);
                            expect(wait.match.sinceCommandIdPrefix, wait.commandId).toBeUndefined();
                            expect(validateRallarBlackBoxTestCommand(wait), wait.commandId).toMatchObject({ ok: true });
                            if ((PRINCIPAL_TRACK_ENTRY_WAITS as readonly string[]).includes(name)) {
                                expectPrincipalTrackEntry(wait);
                            }
                            else {
                                expectFreshDocumentRecovery(toAlmConformanceRoleRecipe(scenario, role)!, role, wait);
                            }
                            continue;
                        }
                        // The one wait that starts later in its own cell: the sibling's removal, read from `armed` on.
                        const ownStart = wait.commandId === `${cellPrefix}-${role}-sibling-left`
                            ? `${cellPrefix}-${role}-armed`
                            : `${cellPrefix}-${role}-`;
                        expect(wait.match.sinceCommandIdPrefix, wait.commandId).toBe(ownStart);
                    }
                }
                const continuation = scenario.continuation;
                for (const wait of continuation ? toWaitCommands(continuation.recipe.commands) : []) {
                    expect(wait.metadata?.historyFrom, wait.commandId).toBeUndefined();
                    expect(wait.match.sinceCommandIdPrefix, wait.commandId).toBe(`${cellPrefix}-${continuation!.role}-`);
                }
            }
        }

        // A further page-history wait is a red test, not a silent drift.
        expect(new Set(pageHistoryWaits)).toEqual(new Set(PAGE_HISTORY_WAITS));
    });

    it('an entry wait on a track its cell does not key reads the page\'s history, whichever cell entered the track', () => {
        const outsideTheCell: string[] = [];
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(toConformanceInput(carrier))) {
                for (const role of scenario.roles) {
                    const waits = toWaitCommands(scenario.partsByRole[role]!.body)
                        .filter((wait) => isFirstContactOutsideTheCell(wait, scenario.scenarioKey));
                    for (const wait of waits) {
                        outsideTheCell.push(wait.commandId!.slice(`alm-${carrier}-`.length));
                        expect(wait.metadata?.historyFrom, wait.commandId).toBe('page');
                    }
                }
            }
        }

        expect(new Set(outsideTheCell)).toEqual(new Set(PRINCIPAL_TRACK_ENTRY_WAITS));
    });

    it('the delivery-diagnostics freshness waits read the whole page history', () => {
        for (const almDiagnostics of [true, false]) {
            const scenario = createAlmDeliveryDiagnosticsRecipes(toConformanceInput('ws'), almDiagnostics);
            for (const role of scenario.roles) {
                const freshWaits = toWaitCommands(scenario.partsByRole[role]!.prologue)
                    .filter((wait) => wait.commandId?.includes(`-${role}-fresh-`));

                expect(freshWaits.map((wait) => wait.commandId?.split('-fresh-')[1])).toEqual([
                    'outbound_diagnostics',
                    'inbound_diagnostics',
                    'storage',
                    'storage_reset',
                    'phase_completed'
                ]);
                expect(freshWaits.every((wait) => wait.match.sinceCommandIdPrefix === undefined)).toBe(true);
                const prefix = `alm-ws-${scenario.scenarioKey}-${role}-`;
                const prologue = scenario.partsByRole[role]!.prologue;
                // The applied-diagnostics wait reads the prologue connect's own phase, so it closes the prologue unmarked.
                expect(prologue.map((command) => command.commandId!.slice(prefix.length)).slice(-4)).toEqual([
                    'ensure-group',
                    'ensure-member',
                    'connect',
                    'applied-diagnostics'
                ]);
                expect(prologue.at(-1)).toMatchObject({
                    kind: 'wait',
                    match: { topic: 'rallar.browser.connect.phase_completed' }
                });
                expect(prologue.at(-1)).not.toHaveProperty('match.sinceCommandIdPrefix');
                expect(
                    toWaitCommands(scenario.partsByRole[role]!.body).every((wait) =>
                        wait.match.sinceCommandIdPrefix === `alm-ws-${scenario.scenarioKey}-${role}-`
                    )
                ).toBe(true);
            }
        }
    });
});
