import {
    describe,
    expect,
    it
} from 'vitest';

import { isRallarBlackBoxTestMessagesSendCommand } from '@shared-test/rallar-bb-test/alm/is-rallar-black-box-test-messages-send-command.ts';
import { RALLAR_BLACK_BOX_BARRIER_RESOLUTION_GRACE_MS } from '@shared-test/rallar-bb-test/barrier/rallar-black-box-barrier-resolution-grace-ms.ts';
import { CONNECT_READINESS_TIMEOUT_MS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import { requireAlmCellParts } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-cell-parts.ts';
import { ALM_CONFORMANCE_ROLES, type AlmConformanceRole } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import type { CreateAlmConformanceRecipesInput } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import { toAlmCellArming } from '@shared-test/rallar-bb-test/conformance/alm/cell/to-alm-cell-arming.ts';
import { toAlmCellAuthoredCommands } from '@shared-test/rallar-bb-test/conformance/alm/cell/to-alm-cell-authored-commands.ts';
import { toAlmCellPlacedBody } from '@shared-test/rallar-bb-test/conformance/alm/cell/to-alm-cell-placed-body.ts';
import {
    createAlmConformanceRecipes,
    createAlmDeliveryDiagnosticsRecipes,
    toAlmConformanceRoleRecipe,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type {
    RallarBlackBoxTestBarrierCommand,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';
import { isStartStateCommand } from './describe-declared-start-states.ts';
import { toNestedCommands } from './to-nested-commands.ts';
import { toWaitCommands } from './to-wait-commands.ts';

function toBarrieredInput(carrier: AlmConformanceCarrier): CreateAlmConformanceRecipesInput {
    return { ...toConformanceInput(carrier), cellSettle: 'barriered' };
}

function toBarrierCommands(recipe: RallarBlackBoxTestRecipe): readonly RallarBlackBoxTestBarrierCommand[] {
    return toNestedCommands(recipe.commands).filter((command): command is RallarBlackBoxTestBarrierCommand => command.kind === 'barrier');
}

describe('alm-conformance cell parts', () => {
    it('a role the cell declares without its parts names the scenario and the role', () => {
        expect(() => requireAlmCellParts({}, 'claim-first-wins', 'recipient-b'))
            .toThrow('ALM scenario claim-first-wins declares recipient-b without its parts.');
    });

    it('every settle role of a barriered cell meets at its cell\'s connected barrier right after its prologue, naming the cell\'s settle roles', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(toBarrieredInput(carrier))) {
                const cellPrefix = `alm-${carrier}-${scenario.scenarioKey}`;
                const settleRoles = scenario.roles.filter((role) => role !== 'successor');
                for (const role of scenario.roles) {
                    const recipe = toAlmConformanceRoleRecipe(scenario, role)!;
                    const { prologue, body } = scenario.partsByRole[role]!;
                    const barriers = toNestedCommands(recipe.commands).filter((command) => command.kind === 'barrier');
                    if (role === 'successor') {
                        expect(barriers, `${scenario.scenarioKey} ${role}`).toEqual([]);
                        continue;
                    }
                    expect(recipe.commands.slice(0, prologue.length + 1), `${scenario.scenarioKey} ${role}`).toEqual([...prologue, barriers[0]]);
                    expect(barriers, `${scenario.scenarioKey} ${role}`).toEqual(SETTLE_BARRIER_PHASES.map((phase) => ({
                        kind: 'barrier',
                        commandId: `${cellPrefix}-${role}-${phase}`,
                        barrierId: `${cellPrefix}-${phase}`,
                        timeoutMs: expect.any(Number),
                        participants: settleRoles,
                        metadata: { cellSettle: 'lane' }
                    })));
                    expect(
                        recipe.commands.filter((command) => command.kind !== 'barrier' && !isSettleCommand(command, `${cellPrefix}-${role}-`)),
                        `${scenario.scenarioKey} ${role}`
                    ).toEqual([...prologue, ...body]);
                }
            }
        }
    });

    it('barrier ids are unique per cell across a carrier\'s catalog', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const barrierIdsByCell = createAlmConformanceRecipes(toBarrieredInput(carrier)).map((scenario) =>
                new Set(scenario.roles.flatMap((role) => toBarrierCommands(toAlmConformanceRoleRecipe(scenario, role)!)).map((barrier) => barrier.barrierId))
            );
            const barrierIds = barrierIdsByCell.flatMap((ids) => [...ids]);

            expect(barrierIdsByCell.every((ids) => ids.size === SETTLE_BARRIER_PHASES.length), carrier).toBe(true);
            expect(new Set(barrierIds).size, carrier).toBe(barrierIds.length);
        }
    });

    it('a cell created without cellSettle carries no barrier', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarios = [
                ...createAlmConformanceRecipes(toConformanceInput(carrier)),
                createAlmDeliveryDiagnosticsRecipes(toConformanceInput(carrier), true)
            ];
            for (const scenario of scenarios) {
                for (const role of scenario.roles) {
                    expect(toBarrierCommands(toAlmConformanceRoleRecipe(scenario, role)!), `${scenario.scenarioKey} ${role}`)
                        .toEqual([]);
                }
            }
        }
    });

    it('a connected barrier\'s timeout covers the other roles\' prologues', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(toBarrieredInput(carrier))) {
                const settleRoles = scenario.roles.filter((role) => role !== 'successor');
                const prologueMs = (role: AlmConformanceRole) => scenario.partsByRole[role]!.prologue.reduce((sum, command) => sum + command.timeoutMs!, 0);
                const othersMs = settleRoles.map((role) => settleRoles.filter((other) => other !== role).reduce((sum, other) => sum + prologueMs(other), 0));
                const timeouts = settleRoles.map((role) => toBarrierCommands(toAlmConformanceRoleRecipe(scenario, role)!)[0]!.timeoutMs);

                // Every arrival names one timeout, or the control server refuses the later ones as conflicting.
                expect(new Set(timeouts), scenario.scenarioKey).toEqual(new Set([Math.max(...othersMs) + RALLAR_BLACK_BOX_BARRIER_RESOLUTION_GRACE_MS]));
            }
        }
        // Each settle prologue is 5 000 + 5 000 + 45 000 ms; the first arrival waits through every other one, then the
        // 10 000 ms a barrier verdict and the pages' skew may take.
        const timeoutOf = (scenarioKey: string, role: AlmConformanceRole) =>
            toBarrierCommands(
                toAlmConformanceRoleRecipe(
                    createAlmConformanceRecipes(toBarrieredInput('rtc')).find((scenario) => scenario.scenarioKey === scenarioKey)!,
                    role
                )!
            )[0]?.timeoutMs;
        expect(timeoutOf('delivery-baseline', 'receiver')).toBe(65_000);
        expect(timeoutOf('aggregated-receipt', 'recipient-b')).toBe(120_000);
        expect(timeoutOf('subscription-delivery', 'publisher-b')).toBe(175_000);
    });

    it('a role recipe is its prologue then its body', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(toConformanceInput(carrier))) {
                for (const role of ALM_CONFORMANCE_ROLES) {
                    const recipe = toAlmConformanceRoleRecipe(scenario, role);
                    const parts = scenario.partsByRole[role];
                    expect(parts === undefined, `${scenario.scenarioKey} ${role}`).toBe(recipe === undefined);
                    if (recipe === undefined || parts === undefined) {
                        continue;
                    }
                    const prefix = `alm-${carrier}-${scenario.scenarioKey}-${role}-`;

                    expect(recipe.commands).toEqual([...parts.prologue, ...toAlmCellPlacedBody(parts)]);
                    expect(parts.prologue.map((command) => command.commandId!.slice(prefix.length))).toEqual([
                        'ensure-group',
                        'ensure-member',
                        ...(role === 'successor' ? ['owner-lease-lapses'] : []),
                        'connect'
                    ]);
                    if (role === 'sender') {
                        // The baseline follows the sender's leading cue-subscription pair, or opens the body without one.
                        const leadsWithSubscription = parts.body[0]?.metadata?.cellArming === 'cue-subscription';
                        const baselineAt = leadsWithSubscription ? 2 : 0;
                        expect(
                            parts.body.slice(0, baselineAt).map((command) => command.metadata?.cellArming),
                            scenario.scenarioKey
                        ).toEqual(Array.from({ length: baselineAt }, () => 'cue-subscription'));
                        expect(parts.body[baselineAt]?.commandId, scenario.scenarioKey).toBe(`${prefix}storage-counters-connected`);
                    }
                    expect(parts.body.at(-1)?.commandId).toBe(`${prefix}stats`);
                }
            }
        }
    });

    it('every role that waits for a cue subscribes within its arming run', () => {
        const subscribedByCarrier = new Map<AlmConformanceCarrier, number>();
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(toBarrieredInput(carrier))) {
                for (const role of scenario.roles) {
                    const recipe = toAlmConformanceRoleRecipe(scenario, role)!;
                    if (!toNestedCommands(recipe.commands).some(isCueWait)) {
                        continue;
                    }
                    // Role recipes only: a continuation carries no barrier, and the next test pins how it hears its cues.
                    // A successor carries no barrier, so no role relies on it to hear a cue sent at its start.
                    expect(role, scenario.scenarioKey).not.toBe('successor');
                    const listens = toArmingRun(recipe, `alm-${carrier}-${scenario.scenarioKey}`, role)
                        .filter((command) => isCueSend(command) && command.payload.cue === 'listen');
                    expect(listens, `${scenario.scenarioKey} ${role}`).toHaveLength(1);
                    subscribedByCarrier.set(carrier, (subscribedByCarrier.get(carrier) ?? 0) + 1);
                }
            }
        }
        expect(Object.fromEntries(subscribedByCarrier)).toEqual({ ws: 18, rtc: 47, 'rtc-with-ws-fallback': 19 });
    });

    // A continuation carries no barrier and no arming run: it runs on the connection its role's first recipe opened,
    // so the cues it waits for reach it through that recipe's subscription, armed before any role's body cued.
    it('a continuation that waits for a cue runs on a role whose first recipe subscribed within its arming run', () => {
        const continuationsWaitingByCarrier = new Map<AlmConformanceCarrier, string[]>();
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(toBarrieredInput(carrier))) {
                const continuation = scenario.continuation;
                if (continuation === undefined || !toNestedCommands(continuation.recipe.commands).some(isCueWait)) {
                    continue;
                }
                const firstRecipe = toAlmConformanceRoleRecipe(scenario, continuation.role)!;
                const listens = toArmingRun(firstRecipe, `alm-${carrier}-${scenario.scenarioKey}`, continuation.role)
                    .filter((command) => isCueSend(command) && command.payload.cue === 'listen');

                expect(toBarrierCommands(continuation.recipe), scenario.scenarioKey).toEqual([]);
                expect(toNestedCommands(continuation.recipe.commands).filter(isCueSend).map((command) => command.payload.cue))
                    .not.toContain('listen');
                expect(listens, `${scenario.scenarioKey} ${continuation.role}`).toHaveLength(1);
                continuationsWaitingByCarrier.set(carrier, [
                    ...(continuationsWaitingByCarrier.get(carrier) ?? []),
                    `${scenario.scenarioKey} ${continuation.role}`
                ]);
            }
        }
        // Today exactly one continuation waits for cues; a second one is a red test, not a silent drift.
        expect(Object.fromEntries(continuationsWaitingByCarrier)).toEqual(Object.fromEntries(
            ALM_CONFORMANCE_CARRIERS.map((carrier) => [carrier, ['subscription-ordered-reconnect sibling']])
        ));
    });

    it('no cell whose sender subscribes to cues reads the sender\'s storage baseline again', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(toConformanceInput(carrier))) {
                const sender = scenario.partsByRole.sender!.body;
                if (sender[0]?.metadata?.cellArming !== 'cue-subscription') {
                    continue;
                }
                const baselineId = `alm-${carrier}-${scenario.scenarioKey}-sender-storage-counters-connected`;
                const recipes = [
                    ...scenario.roles.map((role) => toAlmConformanceRoleRecipe(scenario, role)!),
                    ...(scenario.continuation ? [scenario.continuation.recipe] : [])
                ];
                // A post-run assessment reads a sender's counters by position, so a second reading is a comparison.
                expect(
                    toNestedCommands(scenario.sender.commands).filter((command) => command.kind === 'storage.counters')
                        .map((command) => command.commandId),
                    scenario.scenarioKey
                ).toEqual([baselineId]);
                expect(recipes.filter((recipe) => JSON.stringify(recipe).includes(`resultCache.${baselineId}`)), scenario.scenarioKey)
                    .toEqual([]);
            }
        }
    });

    it('no role sends a cue other than its subscription before its armed barrier', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(toBarrieredInput(carrier))) {
                const cellPrefix = `alm-${carrier}-${scenario.scenarioKey}`;
                for (const role of scenario.roles.filter((candidate) => candidate !== 'successor')) {
                    const recipe = toAlmConformanceRoleRecipe(scenario, role)!;
                    const armedAt = recipe.commands.findIndex((command) => command.commandId === `${cellPrefix}-${role}-armed`);
                    const cues = toNestedCommands(recipe.commands.slice(0, armedAt)).filter(isCueSend);

                    expect(armedAt, `${scenario.scenarioKey} ${role}`).toBeGreaterThan(0);
                    expect(cues.map((command) => command.payload.cue), `${scenario.scenarioKey} ${role}`)
                        .toEqual(cues.length === 0 ? [] : ['listen']);
                }
            }
        }
    });

    it('every settle role of a barriered cell runs connected barrier, [receiver: formation poll], formation-settled barrier, head read, applied-revision floor wait, its leading faults, armed barrier — in that order, before its first other body command', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(toBarrieredInput(carrier))) {
                const cellPrefix = `alm-${carrier}-${scenario.scenarioKey}`;
                for (const role of scenario.roles.filter((candidate) => candidate !== 'successor')) {
                    const recipe = toAlmConformanceRoleRecipe(scenario, role)!;
                    const { prologue, body } = scenario.partsByRole[role]!;
                    const { arming, rest } = toAlmCellArming(body);
                    const [connected, formationSettled, armed] = toBarrierCommands(recipe);
                    const settle = toSettleCommands(recipe, `${cellPrefix}-${role}-`);

                    expect([connected, formationSettled, armed].map((barrier) => barrier?.commandId))
                        .toEqual(SETTLE_BARRIER_PHASES.map((phase) => `${cellPrefix}-${role}-${phase}`));
                    const formation = settle.slice(0, -2);
                    // The receiver's start state, if its cell declares one, leads its formation poll: one request per write.
                    expect(formation.map((command) => command.kind), `${scenario.scenarioKey} ${role}`)
                        .toEqual(
                            formation.map((command, index) => index === formation.length - 1 ? 'loop' : isStartStateCommand(command) ? 'http.request' : 'loop')
                        );
                    expect(formation.length > 0, `${scenario.scenarioKey} ${role}`).toBe(role === 'receiver');
                    if (role === 'receiver') {
                        expect(formation.slice(0, -1).every(isStartStateCommand), `${scenario.scenarioKey} ${role}`).toBe(true);
                        expect(formation.at(-1)?.commandId, `${scenario.scenarioKey} ${role}`).toBe(`${cellPrefix}-receiver-formation-poll`);
                    }
                    expect(settle.slice(-2).map((command) => command.kind), `${scenario.scenarioKey} ${role}`)
                        .toEqual(['http.request', 'wait']);
                    const [headRead, headApplied] = settle.slice(-2);
                    expect(recipe.commands, `${scenario.scenarioKey} ${role}`).toEqual([
                        ...prologue,
                        connected,
                        ...settle.slice(0, -2),
                        formationSettled,
                        headRead,
                        headApplied,
                        ...arming,
                        armed,
                        ...rest
                    ]);
                }
            }
        }
    });

    it('a granted cell\'s settle orders the start-state writes before the applied wait and holds no poll after it', () => {
        let granted = 0;
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(toBarrieredInput(carrier))) {
                const cellPrefix = `alm-${carrier}-${scenario.scenarioKey}`;
                const recipe = toAlmConformanceRoleRecipe(scenario, 'receiver')!;
                const ids = recipe.commands.map((command) => command.commandId);
                const startState = recipe.commands.filter(isStartStateCommand);
                if (startState.length === 0) {
                    continue;
                }
                granted += 1;
                const writeAts = startState.map((command) => ids.indexOf(command.commandId));
                const connectedAt = ids.indexOf(`${cellPrefix}-receiver-connected`);
                const headAppliedAt = ids.indexOf(`${cellPrefix}-receiver-head-applied`);
                const armedAt = ids.indexOf(`${cellPrefix}-receiver-armed`);

                // Each write is one request, not a poll of requests, and runs after every role connected.
                expect(startState.map((command) => command.kind), scenario.scenarioKey).toEqual(startState.map(() => 'http.request'));
                expect(startState.every((command) => command.timeoutMs === 5_000), scenario.scenarioKey).toBe(true);
                expect(Math.min(...writeAts), scenario.scenarioKey).toBeGreaterThan(connectedAt);
                // Every write precedes the page's applied wait; after it the settle holds nothing but the arming run.
                expect(Math.max(...writeAts), scenario.scenarioKey).toBeLessThan(headAppliedAt);
                expect(
                    recipe.commands.slice(headAppliedAt + 1, armedAt).filter((command) => command.metadata?.cellSettle === 'lane'),
                    scenario.scenarioKey
                ).toEqual([]);
                expect(
                    recipe.commands.slice(headAppliedAt + 1, armedAt).some((command) =>
                        command.kind === 'loop' && toNestedCommands([command]).some(isStartStateCommand)
                    ),
                    scenario.scenarioKey
                ).toBe(false);
            }
        }
        expect(granted).toBeGreaterThan(0);
    });

    it('only the receiver polls', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(toBarrieredInput(carrier))) {
                const cellPrefix = `alm-${carrier}-${scenario.scenarioKey}`;
                const recipes = [
                    ...scenario.roles.map((role) => toAlmConformanceRoleRecipe(scenario, role)!),
                    ...(scenario.continuation ? [scenario.continuation.recipe] : [])
                ];
                const polls = recipes.flatMap((recipe) =>
                    toNestedCommands(recipe.commands).filter((command) => command.commandId?.endsWith('-formation-poll'))
                );

                // Every cell has a receiver, which creates the room and owns it.
                expect(scenario.roles, scenario.scenarioKey).toContain('receiver');
                expect(polls.map((command) => command.commandId), scenario.scenarioKey)
                    .toEqual([`${cellPrefix}-receiver-formation-poll`]);
                expect(polls[0], scenario.scenarioKey).toMatchObject({
                    kind: 'loop',
                    until: 'first-success',
                    intervalMs: 250,
                    count: CONNECT_READINESS_TIMEOUT_MS / 250
                });
            }
        }
    });

    it('the applied wait floors both revisions at the page\'s own head read and names the cell\'s group', () => {
        const group = toConformanceInput('rtc').group;
        const groupPath = `/api/state/apps/${group.applicationId}/workspaces/${group.workspaceId}/groups/${group.groupId}`;
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(toBarrieredInput(carrier))) {
                for (const role of scenario.roles.filter((candidate) => candidate !== 'successor')) {
                    const prefix = `alm-${carrier}-${scenario.scenarioKey}-${role}-`;
                    const recipe = toAlmConformanceRoleRecipe(scenario, role)!;
                    const [headRead, headApplied] = toSettleCommands(recipe, prefix).slice(-2);
                    const head = `{resultCache.${prefix}head-read.value.body.causalRevision`;

                    expect(headRead, `${scenario.scenarioKey} ${role}`).toMatchObject({
                        kind: 'http.request',
                        commandId: `${prefix}head-read`,
                        request: { method: 'GET', path: groupPath },
                        response: { body: 'json', acceptedStatusCodes: [200] }
                    });
                    expect(headApplied, `${scenario.scenarioKey} ${role}`).toEqual({
                        kind: 'wait',
                        commandId: `${prefix}head-applied`,
                        // No connection: the bridged diagnostic carries none, and a wait refuses a mismatch.
                        match: {
                            kind: 'diagnostic',
                            topic: 'rallar.browser.group_state.applied',
                            payloadFields: {
                                'data.change': 'held',
                                'data.groupRef.applicationId': group.applicationId,
                                'data.groupRef.workspaceId': group.workspaceId,
                                'data.groupRef.groupId': group.groupId
                            },
                            payloadMinimums: {
                                'data.groupRevision': `${head}.groupRevision}`,
                                'data.presenceRevision': `${head}.presenceRevision}`
                            }
                        },
                        timeoutMs: CONNECT_READINESS_TIMEOUT_MS,
                        metadata: { historyFrom: 'page', cellSettle: 'lane' }
                    });
                    expect(validateRallarBlackBoxTestCommand(headApplied!), headApplied!.commandId).toMatchObject({ ok: true });
                }
            }
        }
    });

    it('a barriered role recipe reads the page\'s history only in its head-applied wait, its principal-track entries and its fresh-document recoveries', () => {
        const pageHistoryWaits = new Set<string>();
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(toBarrieredInput(carrier))) {
                for (const role of scenario.roles) {
                    const prefix = `alm-${carrier}-${scenario.scenarioKey}-${role}-`;
                    // The prologue opens the cell's mark, so its waits read the page's history by construction.
                    const afterPrologue = toAlmConformanceRoleRecipe(scenario, role)!.commands
                        .slice(scenario.partsByRole[role]!.prologue.length);
                    for (const wait of toWaitCommands(afterPrologue)) {
                        const marked = wait.match.sinceCommandIdPrefix !== undefined;
                        const pageHistory = wait.metadata?.historyFrom === 'page';
                        // Exactly one of the two: the cell's mark, or the declaration that it reads the page's history.
                        expect(marked !== pageHistory, wait.commandId).toBe(true);
                        if (pageHistory) {
                            pageHistoryWaits.add(wait.commandId!.slice(prefix.length));
                        }
                    }
                }
            }
        }

        // A further unmarked wait is a red test, not a silent drift.
        expect(pageHistoryWaits).toEqual(
            new Set([
                'head-applied',
                'entered',
                'recovered-original-store',
                'recovered-checkpoint-store',
                'recovered-session-inbound'
            ])
        );
    });

    it('the settle\'s timeouts are derived from the commands they wait out', () => {
        const timeoutsOf = (scenario: AlmConformanceScenario, role: AlmConformanceRole) =>
            toBarrierCommands(toAlmConformanceRoleRecipe(scenario, role)!).map((barrier) => barrier.timeoutMs);
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(toBarrieredInput(carrier))) {
                const cellPrefix = `alm-${carrier}-${scenario.scenarioKey}`;
                const settleRoles = scenario.roles.filter((role) => role !== 'successor');
                const settleOf = (role: AlmConformanceRole) => toSettleCommands(toAlmConformanceRoleRecipe(scenario, role)!, `${cellPrefix}-${role}-`);
                const formationMs = (role: AlmConformanceRole) => toCommandsMs(settleOf(role).slice(0, -2));
                const armedMs = (role: AlmConformanceRole) =>
                    toCommandsMs([...settleOf(role).slice(-2), ...toAlmCellArming(scenario.partsByRole[role]!.body).arming]);
                const longestOthersMs = (toMs: (role: AlmConformanceRole) => number) =>
                    Math.max(...settleRoles.map((role) => settleRoles.filter((other) => other !== role).reduce((sum, other) => sum + toMs(other), 0))) +
                    RALLAR_BLACK_BOX_BARRIER_RESOLUTION_GRACE_MS;

                // One timeout per barrier of a cell: the others' commands plus the grace a verdict and the pages' skew take.
                for (const role of settleRoles) {
                    expect(timeoutsOf(scenario, role).slice(1), `${scenario.scenarioKey} ${role}`)
                        .toEqual([longestOthersMs(formationMs), longestOthersMs(armedMs)]);
                }
            }
        }
        // The poll is 30 000 ms of attempts and one 5 000 ms command; a head read is 5 000 ms and its applied wait
        // 30 000 ms; a cue subscription is two 5 000 ms commands and a fault 3 000 ms; each write of a start state is one
        // 5 000 ms request, four of them for the first cell below and six for the second. The first arrival waits through
        // every other role's commands, then the 10 000 ms grace.
        const timeoutsAt = (carrier: AlmConformanceCarrier, scenarioKey: string) =>
            timeoutsOf(createAlmConformanceRecipes(toBarrieredInput(carrier)).find((scenario) => scenario.scenarioKey === scenarioKey)!, 'receiver')
                .slice(1);
        expect(timeoutsAt('rtc', 'delivery-baseline')).toEqual([45_000, 45_000]);
        expect(timeoutsAt('rtc', 'granted-rtc-delivered')).toEqual([65_000, 55_000]);
        expect(timeoutsAt('rtc', 'receipted-relay-path')).toEqual([45_000, 100_000]);
        expect(timeoutsAt('rtc', 'forged-recipient-ack')).toEqual([45_000, 103_000]);
        expect(timeoutsAt('ws', 'subscription-delivery')).toEqual([75_000, 135_000]);
    });

    it('a barriered role recipe\'s authored commands are its prologue then its body, as without a settle', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const plain = createAlmConformanceRecipes(toConformanceInput(carrier));
            for (const [index, scenario] of createAlmConformanceRecipes(toBarrieredInput(carrier)).entries()) {
                for (const role of scenario.roles) {
                    const recipe = toAlmConformanceRoleRecipe(scenario, role)!;
                    const prefix = `alm-${carrier}-${scenario.scenarioKey}-${role}-`;

                    expect(toAlmCellAuthoredCommands(recipe.commands), `${scenario.scenarioKey} ${role}`)
                        .toEqual(toAlmConformanceRoleRecipe(plain[index]!, role)!.commands.filter((command) => !isStartStateCommand(command)));
                    // Every command the authored view leaves out is a settle command, and every settle command is declared.
                    expect(
                        recipe.commands.filter((command) => !toAlmCellAuthoredCommands(recipe.commands).includes(command))
                            .every((command) => command.kind === 'barrier' || isSettleCommand(command, prefix)),
                        `${scenario.scenarioKey} ${role}`
                    ).toBe(true);
                }
            }
        }
    });

    it('a cell without cellSettle carries no poll, head read or settle barrier', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarios = [
                ...createAlmConformanceRecipes(toConformanceInput(carrier)),
                createAlmDeliveryDiagnosticsRecipes(toConformanceInput(carrier), false)
            ];
            for (const scenario of scenarios) {
                for (const role of scenario.roles) {
                    const prefix = `alm-${carrier}-${scenario.scenarioKey}-${role}-`;
                    const commands = toNestedCommands(toAlmConformanceRoleRecipe(scenario, role)!.commands);
                    expect(
                        commands.filter((command) => isSettleCommand(command, prefix) || command.kind === 'barrier'),
                        `${scenario.scenarioKey} ${role}`
                    ).toEqual([]);
                }
            }
        }
    });
});

/** A cue's payload names it; the test reads it, the arming owner reads only what the builder declares. */
function isCueWait(command: RallarBlackBoxTestCommand): boolean {
    return command.kind === 'wait' && isJsonRecordValue(command.match.equals) && typeof command.match.equals.cue === 'string';
}

function isCueSend(command: RallarBlackBoxTestCommand): command is RallarBlackBoxTestCommand & { readonly payload: { readonly cue: string; }; } {
    return isRallarBlackBoxTestMessagesSendCommand(command) && isJsonRecordValue(command.payload) && typeof command.payload.cue === 'string';
}

/** The commands a settle role runs between its cell's `connected` and `armed` barriers. */
function toArmingRun(
    recipe: RallarBlackBoxTestRecipe,
    cellPrefix: string,
    role: AlmConformanceRole
): readonly RallarBlackBoxTestCommand[] {
    const ids = recipe.commands.map((command) => command.commandId);
    const connectedAt = ids.indexOf(`${cellPrefix}-${role}-connected`);
    const armedAt = ids.indexOf(`${cellPrefix}-${role}-armed`);
    expect(connectedAt, `${recipe.recipeId} connected`).toBeGreaterThan(0);
    expect(armedAt, `${recipe.recipeId} armed`).toBeGreaterThan(connectedAt);
    return recipe.commands.slice(connectedAt + 1, armedAt);
}

/** The settle's barrier phases, in the order every settle role meets at them. */
const SETTLE_BARRIER_PHASES = ['connected', 'formation-settled', 'armed'] as const;

/** The settle's command names: the receiver's formation poll, then each page's head read and its applied wait. */
const SETTLE_COMMAND_NAMES = ['formation-poll', 'head-read', 'head-applied'] as const;

function isSettleCommand(command: RallarBlackBoxTestCommand, rolePrefix: string): boolean {
    return SETTLE_COMMAND_NAMES.some((name) => command.commandId === `${rolePrefix}${name}`) || isSettledStartState(command);
}

function isSettledStartState(command: RallarBlackBoxTestCommand): boolean {
    return isStartStateCommand(command) && command.metadata?.cellSettle === 'lane';
}

/** A role recipe's settle commands, in recipe order. */
function toSettleCommands(recipe: RallarBlackBoxTestRecipe, rolePrefix: string): readonly RallarBlackBoxTestCommand[] {
    return recipe.commands.filter((command) => isSettleCommand(command, rolePrefix));
}

function toCommandsMs(commands: readonly RallarBlackBoxTestCommand[]): number {
    return commands.reduce((sum, command) => sum + command.timeoutMs!, 0);
}
