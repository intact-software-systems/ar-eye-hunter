import { describe, expect, it } from 'vitest';

import { NON_EXPIRING_SEND_TIMEOUT_MS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { CreateAlmConformanceRecipesInput } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import { readAlmReceiptRolesEntries } from '@shared-test/rallar-bb-test/conformance/alm/assess-alm-receipt-role-identity.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const LEADER_SCENARIO_IDS = ['leader-confirms', 'no-leader-refused', 'leader-outside-list'] as const;
const PROLOGUE = ['ensure-group', 'ensure-member', 'connect'] as const;
const ROOM_REF = { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' };
const RECEIPT_WINDOW = [
    'received-self-1',
    'receipts-1',
    'assert-receipt-state-1',
    'assert-receipt-receiptMode-1',
    'assert-receipt-expectedRecipientPeerIds-count-1',
    'assert-receipt-confirmedRecipientPeerIds-count-1',
    'assert-receipt-unconfirmedRecipientPeerIds-count-1'
] as const;

type LeaderScenarioId = (typeof LEADER_SCENARIO_IDS)[number];

const LEADER_CARRIERS: Readonly<Record<LeaderScenarioId, readonly AlmConformanceCarrier[]>> = {
    'leader-confirms': ALM_CONFORMANCE_CARRIERS,
    'no-leader-refused': ['ws', 'rtc'],
    'leader-outside-list': ['ws']
};

function findScenario(input: CreateAlmConformanceRecipesInput, scenarioId: LeaderScenarioId): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(input).find((candidate) => candidate.scenarioId === scenarioId);
    if (scenario === undefined) {
        throw new Error(`Missing ${scenarioId} over ${input.carrier}.`);
    }
    return scenario;
}

function requireRecipientB(scenario: AlmConformanceScenario): RallarBlackBoxTestRecipe {
    if (scenario.recipientB === undefined) {
        throw new Error(`${scenario.scenarioKey} declares no recipient-b.`);
    }
    return scenario.recipientB;
}

function toCommandNames(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    const prefix = `${recipe.recipeId}-`;
    return recipe.commands.map((command) => (command.commandId ?? '').replace(prefix, ''));
}

function findCommand(recipe: RallarBlackBoxTestRecipe, name: string): RallarBlackBoxTestCommand {
    const command = recipe.commands.find((candidate) => candidate.commandId === `${recipe.recipeId}-${name}`);
    if (command === undefined) {
        throw new Error(`${recipe.recipeId} has no ${name}.`);
    }
    return command;
}

function isLeaderScenario(scenario: AlmConformanceScenario): boolean {
    return (LEADER_SCENARIO_IDS as readonly string[]).includes(scenario.scenarioId);
}

/** Runs the sender's verdict tail against one observation of its handle. */
async function readVerdictTail(sender: RallarBlackBoxTestRecipe, observation: object): Promise<boolean> {
    const from = sender.commands.findIndex((command) => command.kind === 'messages.observe');
    const runtime = createRallarBlackBoxTestRuntime({
        commandExecutor: (command) => command.kind === 'messages.observe' ? { status: 'ok', value: observation } : undefined
    });
    const tail = { ...sender, commands: sender.commands.slice(from, -1) };
    return (await runtime.execute({ kind: 'recipe.run', recipe: tail })).ok;
}

/** Runs the sender's leader wait against a sequence of director reads; returns whether it ended and how many it read. */
async function runLeaderWait(
    sender: RallarBlackBoxTestRecipe,
    activity: readonly boolean[]
): Promise<Readonly<{ ok: boolean; reads: number; }>> {
    const wait = sender.commands.find((command) => command.kind === 'loop');
    let reads = 0;
    const runtime = createRallarBlackBoxTestRuntime({
        sleep: async () => {},
        commandExecutor: (command) => {
            if (command.kind !== 'director.status') {
                return undefined;
            }
            const active = activity[Math.min(reads, activity.length - 1)];
            reads += 1;
            return { status: 'ok', value: { status: 'status', directorStatus: { active } } };
        }
    });
    const result = await runtime.execute(wait?.kind === 'loop' ? { ...wait, count: activity.length } : { kind: 'health' });
    return { ok: result.ok, reads };
}

describe('leader-ack conformance scenarios', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('catalogs the %s leader cells on the three agents, in the full tag only', (carrier) => {
        const cells = createAlmConformanceRecipes(toConformanceInput(carrier))
            .filter(isLeaderScenario)
            .map(({ scenarioId, laneFamily, roles, tags }) => ({ scenarioId, laneFamily, roles, tags }));

        expect(cells).toEqual(
            LEADER_SCENARIO_IDS.filter((scenarioId) => LEADER_CARRIERS[scenarioId].includes(carrier)).map((scenarioId) => ({
                scenarioId,
                laneFamily: 'three-agent',
                roles: ['sender', 'receiver', 'recipient-b'],
                tags: ['full']
            }))
        );
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('gives every %s leader cell identities no other scenario of the run shares, each a valid command', (carrier) => {
        const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));
        const toRecipes = (scenario: AlmConformanceScenario) =>
            [scenario.sender, scenario.receiver, scenario.recipientB, scenario.successor, scenario.sibling]
                .filter((recipe): recipe is RallarBlackBoxTestRecipe => recipe !== undefined);
        const others = new Set(
            scenarios.filter((scenario) => !isLeaderScenario(scenario)).flatMap(toRecipes)
                .flatMap((recipe) => recipe.commands.map((command) => command.commandId))
        );
        const own = scenarios.filter(isLeaderScenario).flatMap(toRecipes).flatMap((recipe) => recipe.commands);

        expect(own.map((command) => command.commandId).filter((commandId) => others.has(commandId))).toEqual([]);
        expect(new Set(own.map((command) => command.commandId)).size).toBe(own.length);
        for (const command of own) {
            expect(validateRallarBlackBoxTestCommand(command), command.commandId).toEqual({ ok: true });
        }
    });
});

describe('leader-confirms', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)(
        'waits for an active leader over %s, then sends to the room asking for it and pins a leader receipt that expects the receiver alone',
        (carrier) => {
            const scenario = findScenario(toConformanceInput(carrier), 'leader-confirms');

            expect(toCommandNames(scenario.sender)).toEqual([
                ...PROLOGUE,
                'storage-counters-connected',
                'await-leader',
                'send-1',
                'observe-admitted-1',
                'assert-admitted-1',
                ...(carrier === 'ws' ? ['receipt-admitted-1'] : []),
                ...RECEIPT_WINDOW,
                'stats'
            ]);
            expect(findCommand(scenario.sender, 'send-1')).toMatchObject({
                kind: 'messages.send',
                carrier,
                ack: 'group-leader',
                reliability: 'at-least-once',
                payload: { marker: 'leader-confirms', carrier }
            });
            expect(findCommand(scenario.sender, 'send-1')).not.toHaveProperty('scope');
            expect(findCommand(scenario.sender, 'send-1')).not.toHaveProperty('recipientPeer');
            expect(findCommand(scenario.sender, 'assert-receipt-receiptMode-1')).toMatchObject({ expected: 'leader' });
            expect(findCommand(scenario.sender, 'assert-receipt-expectedRecipientPeerIds-count-1')).toMatchObject({ expected: 1 });
            expect(readAlmReceiptRolesEntries(scenario.sender)).toEqual([
                { handleId: `alm-${carrier}-leader-confirms-send-1`, confirmed: ['receiver'], unconfirmed: [] }
            ]);
        }
    );

    it('appoints the receiver on its own page before it receives the send once, and resigns after its window; recipient-b never receives it', () => {
        const scenario = findScenario(toConformanceInput('rtc'), 'leader-confirms');

        expect(toCommandNames(scenario.receiver)).toEqual([
            ...PROLOGUE,
            'director-appoint',
            'received-1',
            'received-2',
            'director-resign',
            'stats'
        ]);
        expect(findCommand(scenario.receiver, 'director-appoint')).toMatchObject({ kind: 'director.appoint', roomRef: ROOM_REF });
        expect(findCommand(scenario.receiver, 'director-resign')).toMatchObject({ kind: 'director.resign', roomRef: ROOM_REF });
        expect(findCommand(scenario.receiver, 'received-1')).toMatchObject({ count: 1, absent: false });
        expect(toCommandNames(requireRecipientB(scenario))).toEqual([...PROLOGUE, 'received-1', 'stats']);
        expect(findCommand(requireRecipientB(scenario), 'received-1')).toMatchObject({
            kind: 'messages.received',
            typeId: 'alm.conformance.rtc.leader-confirms',
            count: 1,
            absent: true,
            windowMs: 17_000
        });
    });

    it('refreshes the sender\'s own room snapshot within the send budget until it reads the director active', () => {
        const wait = findCommand(findScenario(toConformanceInput('rtc'), 'leader-confirms').sender, 'await-leader');
        const [status, active, ...rest] = wait.kind === 'loop' ? wait.commands : [];

        expect(wait).toMatchObject({ kind: 'loop', until: 'first-success', intervalMs: 200 });
        expect(wait.kind === 'loop' ? (wait.count ?? 0) * (wait.intervalMs ?? 0) : 0).toBe(NON_EXPIRING_SEND_TIMEOUT_MS);
        expect(status).toMatchObject({ kind: 'director.status', refresh: true, roomRef: ROOM_REF });
        expect(active).toMatchObject({
            kind: 'assert',
            source: 'resultCache.alm-rtc-leader-confirms-sender-await-leader:i{loop.iteration}:c1:' +
                'alm-rtc-leader-confirms-sender-leader-status.value.directorStatus.active',
            operator: 'equals',
            expected: true
        });
        expect(rest).toEqual([]);
    });

    it.each(
        [
            [[false, false, true], true, 3],
            [[false, false, false], false, 3]
        ] as const
    )('ends the leader wait on the first read of an active director (reads %j, passes %s)', async (activity, passes, reads) => {
        const sender = findScenario(toConformanceInput('ws'), 'leader-confirms').sender;

        expect(await runLeaderWait(sender, activity)).toEqual({ ok: passes, reads });
    });
});

describe('no-leader-refused', () => {
    const refusal = (attempts: number) => ({
        state: 'rejected',
        failure: { kind: 'refused', reason: 'no-leader' },
        attempts,
        attemptCarriers: attempts === 0 ? [] : ['rtc']
    });
    const serverRejection = (reason: string) => ({
        state: 'rejected',
        failure: { kind: 'relay-rejected', rejection: { relay: 'trusted-server', reason } },
        attempts: 1,
        attemptCarriers: ['ws']
    });

    it('reads the rtc leader send rejected, refused no-leader with no carrier attempt, once the sender reads no active director', async () => {
        const scenario = findScenario(toConformanceInput('rtc'), 'no-leader-refused');

        expect(toCommandNames(scenario.sender)).toEqual([
            ...PROLOGUE,
            'storage-counters-connected',
            'await-no-leader',
            'send-1',
            'observe-rejected-1',
            'assert-refused-1',
            'assert-no-leader-1',
            'assert-no-attempt-1',
            'stats'
        ]);
        expect(findCommand(scenario.sender, 'send-1')).toMatchObject({ ack: 'group-leader', carrier: 'rtc' });
        expect(await readVerdictTail(scenario.sender, refusal(0))).toBe(true);
        expect(await readVerdictTail(scenario.sender, { ...refusal(0), failure: { kind: 'refused', reason: 'unsupported' } }))
            .toBe(false);
        expect(await readVerdictTail(scenario.sender, refusal(1))).toBe(false);
        expect(await runLeaderWait(scenario.sender, [true, false])).toEqual({ ok: true, reads: 2 });
    });

    it('reads the ws leader send rejected by the trusted server\'s no-leader NACK on its one attempt', async () => {
        const scenario = findScenario(toConformanceInput('ws'), 'no-leader-refused');

        expect(toCommandNames(scenario.sender)).toEqual([
            ...PROLOGUE,
            'storage-counters-connected',
            'await-no-leader',
            'send-1',
            'observe-rejected-1',
            'assert-relay-rejected-1',
            'assert-trusted-server-1',
            'assert-no-leader-1',
            'assert-one-attempt-1',
            'stats'
        ]);
        expect(await readVerdictTail(scenario.sender, serverRejection('no-leader'))).toBe(true);
        expect(await readVerdictTail(scenario.sender, serverRejection('membership-fenced'))).toBe(false);
        expect(await readVerdictTail(scenario.sender, refusal(0))).toBe(false);
    });

    it('has the receiver resign before its window and neither recipient receive the send', () => {
        const scenario = findScenario(toConformanceInput('rtc'), 'no-leader-refused');

        expect(toCommandNames(scenario.receiver)).toEqual([...PROLOGUE, 'director-resign', 'received-1', 'stats']);
        for (const recipient of [scenario.receiver, requireRecipientB(scenario)]) {
            expect(findCommand(recipient, 'received-1')).toMatchObject({ count: 1, absent: true });
        }
        expect(toCommandNames(requireRecipientB(scenario))).toEqual([...PROLOGUE, 'received-1', 'stats']);
    });
});

describe('leader-outside-list', () => {
    it('lists recipient-b alone beside the appointed receiver and reads the ws send rejected by the server\'s no-leader NACK', async () => {
        const scenario = findScenario(toConformanceInput('ws'), 'leader-outside-list');

        expect(toCommandNames(scenario.sender)).toEqual([
            ...PROLOGUE,
            'storage-counters-connected',
            'await-leader',
            'send-1',
            'observe-rejected-1',
            'assert-relay-rejected-1',
            'assert-trusted-server-1',
            'assert-no-leader-1',
            'assert-one-attempt-1',
            'stats'
        ]);
        expect(findCommand(scenario.sender, 'send-1')).toMatchObject({
            kind: 'messages.send',
            ack: 'group-leader',
            recipientPeer: 'recipient-b',
            payload: { marker: 'leader-outside-list', carrier: 'ws' }
        });
        expect(toCommandNames(scenario.receiver)).toEqual([
            ...PROLOGUE,
            'director-appoint',
            'received-1',
            'director-resign',
            'stats'
        ]);
        for (const recipient of [scenario.receiver, requireRecipientB(scenario)]) {
            expect(findCommand(recipient, 'received-1')).toMatchObject({ count: 1, absent: true });
        }
        expect(
            await readVerdictTail(scenario.sender, {
                state: 'rejected',
                failure: { kind: 'relay-rejected', rejection: { relay: 'trusted-server', reason: 'no-leader' } },
                attempts: 1
            })
        )
            .toBe(true);
    });
});
