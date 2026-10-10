import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
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
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const CLAIM_SCENARIO_IDS = ['claim-first-wins', 'claim-expires-reclaims', 'claim-refused-on-rtc'] as const;
const PROLOGUE = ['ensure-group', 'ensure-member', 'connect'] as const;
const RECEIPT_READ = [
    'receipts-1',
    'assert-receipt-state-1',
    'assert-receipt-receiptMode-1',
    'assert-receipt-expectedRecipientPeerIds-count-1',
    'assert-receipt-confirmedRecipientPeerIds-count-1',
    'assert-receipt-unconfirmedRecipientPeerIds-count-1'
] as const;

type ClaimScenarioId = (typeof CLAIM_SCENARIO_IDS)[number];

const CLAIM_CARRIERS: Readonly<Record<ClaimScenarioId, readonly AlmConformanceCarrier[]>> = {
    'claim-first-wins': ['ws', 'rtc-with-ws-fallback'],
    'claim-expires-reclaims': ['ws'],
    'claim-refused-on-rtc': ['rtc']
};

function findScenario(carrier: AlmConformanceCarrier, scenarioId: ClaimScenarioId): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(toConformanceInput(carrier))
        .find((candidate) => candidate.scenarioId === scenarioId);
    if (scenario === undefined) {
        throw new Error(`Missing ${scenarioId} over ${carrier}.`);
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

function isClaimScenario(scenario: AlmConformanceScenario): boolean {
    return CLAIM_SCENARIO_IDS.some((scenarioId) => scenarioId === scenario.scenarioId);
}

/** Runs the named handle read and the assertions that follow it, answering the read with one observation. */
async function readTail(recipe: RallarBlackBoxTestRecipe, from: string, observation: object): Promise<boolean> {
    const start = recipe.commands.findIndex((command) => command.commandId === `${recipe.recipeId}-${from}`);
    const following = recipe.commands.slice(start + 1);
    const end = following.findIndex((command) => command.kind !== 'assert');
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        commandExecutor: (command) =>
            command.kind === 'messages.observe' || command.kind === 'messages.receipts'
                ? { status: 'ok', value: observation }
                : undefined
    });
    const commands = [recipe.commands[start], ...following.slice(0, end === -1 ? following.length : end)];
    return (await runtime.execute({ kind: 'recipe.run', recipe: { ...recipe, commands } })).ok;
}

/** Each change alone, applied to an observation the read accepts, must fail it: no fact assertion goes unproven. */
interface ReadTailChangeInput {
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly from: string;
    readonly observation: object;
    readonly changes: readonly object[];
}

async function readTailForEachChange({ recipe, from, observation, changes }: ReadTailChangeInput): Promise<readonly boolean[]> {
    const results: boolean[] = [];
    for (const change of changes) {
        results.push(await readTail(recipe, from, { ...observation, ...change }));
    }
    return results;
}

/** A change to the state, the mode and each recipient list length of an acknowledged receipt over two recipients. */
function toReceiptChanges(expectedRecipientPeerIds: readonly string[]): readonly object[] {
    const [first] = expectedRecipientPeerIds;
    return [
        { state: 'rejected' },
        { receiptMode: 'leader' },
        { expectedRecipientPeerIds: [first] },
        { confirmedRecipientPeerIds: [first] },
        { unconfirmedRecipientPeerIds: [first] }
    ];
}

describe('claim conformance scenarios', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('catalogs the %s claim cells on the three agents, in the full tag only', (carrier) => {
        const cells = createAlmConformanceRecipes(toConformanceInput(carrier))
            .filter(isClaimScenario)
            .map(({ scenarioId, laneFamily, roles, tags }) => ({ scenarioId, laneFamily, roles, tags }));

        expect(cells).toEqual(
            CLAIM_SCENARIO_IDS.filter((scenarioId) => CLAIM_CARRIERS[scenarioId].includes(carrier)).map((scenarioId) => ({
                scenarioId,
                laneFamily: 'three-agent',
                roles: ['sender', 'receiver', 'recipient-b'],
                tags: ['full']
            }))
        );
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('gives every %s claim cell identities no other scenario of the run shares, each a valid command', (carrier) => {
        const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));
        const toRecipes = (scenario: AlmConformanceScenario) =>
            [scenario.sender, scenario.receiver, scenario.recipientB, scenario.successor, scenario.sibling]
                .filter((recipe): recipe is RallarBlackBoxTestRecipe => recipe !== undefined);
        const others = new Set(
            scenarios.filter((scenario) => !isClaimScenario(scenario)).flatMap(toRecipes)
                .flatMap((recipe) => recipe.commands.map((command) => command.commandId))
        );
        const own = scenarios.filter(isClaimScenario).flatMap(toRecipes).flatMap((recipe) => recipe.commands);

        expect(own.map((command) => command.commandId).filter((commandId) => others.has(commandId))).toEqual([]);
        expect(new Set(own.map((command) => command.commandId)).size).toBe(own.length);
        for (const command of own) {
            expect(validateRallarBlackBoxTestCommand(command), command.commandId).toEqual({ ok: true });
        }
    });
});

describe('claim-first-wins', () => {
    const receipt = {
        state: 'acknowledged',
        receiptMode: 'receiver',
        expectedRecipientPeerIds: ['receiver-session', 'recipient-b-session'],
        confirmedRecipientPeerIds: ['receiver-session', 'recipient-b-session'],
        unconfirmedRecipientPeerIds: [],
        attempts: 1,
        attemptCarriers: ['ws'],
        carrierFallback: undefined
    };
    const heldByOther = {
        state: 'rejected',
        failure: { kind: 'relay-rejected', rejection: { relay: 'trusted-server', reason: 'held-by-other' } },
        attempts: 1,
        attemptCarriers: ['ws'],
        carrierFallback: undefined
    };

    it.each(CLAIM_CARRIERS['claim-first-wins'])(
        'claims the cell\'s resource over %s with a room send both recipients confirm, and reads one WS attempt with no hand-over',
        async (carrier) => {
            const scenario = findScenario(carrier, 'claim-first-wins');

            expect(toCommandNames(scenario.sender)).toEqual([
                ...PROLOGUE,
                'storage-counters-connected',
                'send-1',
                'observe-admitted-1',
                'assert-admitted-1',
                ...(carrier === 'ws' ? ['receipt-admitted-1'] : []),
                'received-self-1',
                ...RECEIPT_READ,
                'observe-acknowledged-1',
                'assert-one-attempt-1',
                'assert-ws-attempt-1',
                'assert-no-fallback-1',
                'stats'
            ]);
            expect(findCommand(scenario.sender, 'send-1')).toMatchObject({
                kind: 'messages.send',
                connection: 'sender',
                carrier,
                ack: 'all-logical-recipients',
                reliability: 'at-least-once',
                ttlMs: 30_000,
                ownership: 'exclusive',
                resourceId: `claim-${carrier}-claim-first-wins`,
                handleId: `alm-${carrier}-claim-first-wins-send-1`
            });
            expect(readAlmReceiptRolesEntries(scenario.sender)).toEqual([
                {
                    handleId: `alm-${carrier}-claim-first-wins-send-1`,
                    confirmed: ['receiver', 'recipient-b'],
                    unconfirmed: []
                }
            ]);
            expect(await readTail(scenario.sender, 'receipts-1', receipt)).toBe(true);
            expect(
                await readTailForEachChange({
                    recipe: scenario.sender,
                    from: 'receipts-1',
                    observation: receipt,
                    changes: toReceiptChanges(receipt.expectedRecipientPeerIds)
                })
            )
                .toEqual([false, false, false, false, false]);
            expect(await readTail(scenario.sender, 'observe-acknowledged-1', receipt)).toBe(true);
            expect(
                await readTailForEachChange({
                    recipe: scenario.sender,
                    from: 'observe-acknowledged-1',
                    observation: receipt,
                    changes: [
                        { attempts: 2 },
                        { attemptCarriers: ['rtc'] },
                        { carrierFallback: { from: 'rtc', to: 'ws' } }
                    ]
                })
            )
                .toEqual([false, false, false]);
        }
    );

    it.each(CLAIM_CARRIERS['claim-first-wins'])(
        'has recipient-b claim the same resource over %s from its own connection once it received the sender\'s claim, and read the server\'s held-by-other NACK',
        async (carrier) => {
            const recipientB = requireRecipientB(findScenario(carrier, 'claim-first-wins'));
            const handleId = `alm-${carrier}-claim-first-wins-recipient-b-send-1`;

            expect(toCommandNames(recipientB)).toEqual([
                ...PROLOGUE,
                'received-1',
                'send-1',
                'observe-rejected-1',
                'assert-relay-rejected-1',
                'assert-trusted-server-1',
                'assert-held-by-other-1',
                'assert-one-attempt-1',
                'assert-ws-attempt-1',
                'assert-no-fallback-1',
                'received-2',
                'stats'
            ]);
            expect(findCommand(recipientB, 'received-1')).toMatchObject({ connection: 'receiver', count: 1, absent: false });
            expect(findCommand(recipientB, 'received-2')).toMatchObject({ connection: 'receiver', count: 2, absent: true });
            expect(findCommand(recipientB, 'send-1')).toMatchObject({
                kind: 'messages.send',
                connection: 'receiver',
                carrier,
                ack: 'all-logical-recipients',
                ownership: 'exclusive',
                resourceId: `claim-${carrier}-claim-first-wins`,
                handleId
            });
            expect(findCommand(recipientB, 'observe-rejected-1')).toMatchObject({
                kind: 'messages.observe',
                connection: 'receiver',
                handleId,
                state: ['rejected']
            });
            expect(await readTail(recipientB, 'observe-rejected-1', heldByOther)).toBe(true);
            expect(
                await readTailForEachChange({
                    recipe: recipientB,
                    from: 'observe-rejected-1',
                    observation: heldByOther,
                    changes: [
                        { failure: { ...heldByOther.failure, kind: 'refused' } },
                        { failure: { ...heldByOther.failure, rejection: { relay: 'peer', reason: 'held-by-other' } } },
                        { failure: { ...heldByOther.failure, rejection: { relay: 'trusted-server', reason: 'no-leader' } } },
                        { attempts: 2 },
                        { attemptCarriers: ['rtc'] },
                        { carrierFallback: { from: 'rtc', to: 'ws' } },
                        { attempts: 2, attemptCarriers: ['rtc', 'ws'], carrierFallback: { from: 'rtc', to: 'ws' } }
                    ]
                })
            )
                .toEqual([false, false, false, false, false, false, false]);
        }
    );

    it('has the receiver receive the sender\'s claim once and no second copy through its window', () => {
        const receiver = findScenario('ws', 'claim-first-wins').receiver;

        expect(toCommandNames(receiver)).toEqual([...PROLOGUE, 'received-1', 'received-2', 'stats']);
        expect(findCommand(receiver, 'received-2')).toMatchObject({ count: 2, absent: true });
    });
});

describe('claim-expires-reclaims', () => {
    it('claims with a short-lived send, and the sender, its holder, receives recipient-b\'s reclaim', () => {
        const sender = findScenario('ws', 'claim-expires-reclaims').sender;

        expect(toCommandNames(sender)).toEqual([
            ...PROLOGUE,
            'storage-counters-connected',
            'send-1',
            'observe-admitted-1',
            'assert-admitted-1',
            'received-1',
            'received-2',
            'stats'
        ]);
        expect(findCommand(sender, 'send-1')).toMatchObject({
            ttlMs: 3_000,
            timeoutMs: 3_000,
            ack: 'all-logical-recipients',
            ownership: 'exclusive',
            resourceId: 'claim-ws-claim-expires-reclaims'
        });
        expect(findCommand(sender, 'received-1')).toMatchObject({
            kind: 'messages.received',
            connection: 'sender',
            typeId: 'alm.conformance.ws.claim-expires-reclaims',
            count: 1,
            absent: false
        });
        expect(findCommand(sender, 'received-2')).toMatchObject({
            kind: 'messages.received',
            connection: 'sender',
            count: 2,
            absent: true
        });
        expect(readAlmReceiptRolesEntries(sender)).toEqual([]);
    });

    it('has recipient-b hold past the claim\'s lifetime, reclaim the resource and read its receipt acknowledged by the sender and the receiver', async () => {
        const recipientB = requireRecipientB(findScenario('ws', 'claim-expires-reclaims'));

        expect(toCommandNames(recipientB)).toEqual([
            ...PROLOGUE,
            'received-1',
            'await-claim-expiry',
            'send-1',
            'observe-admitted-1',
            'assert-admitted-1',
            'received-2',
            ...RECEIPT_READ,
            'stats'
        ]);
        expect(findCommand(recipientB, 'await-claim-expiry')).toEqual({
            kind: 'messages.received',
            commandId: 'alm-ws-claim-expires-reclaims-recipient-b-await-claim-expiry',
            connection: 'receiver',
            typeId: 'alm.conformance.ws.claim-expires-reclaims',
            count: 2,
            absent: true,
            windowMs: 3_500,
            timeoutMs: 4_500
        });
        expect(findCommand(recipientB, 'send-1')).toMatchObject({
            connection: 'receiver',
            ttlMs: 30_000,
            ownership: 'exclusive',
            resourceId: 'claim-ws-claim-expires-reclaims',
            handleId: 'alm-ws-claim-expires-reclaims-recipient-b-send-1'
        });
        expect(findCommand(recipientB, 'received-2')).toMatchObject({ count: 2, absent: true });
        expect(findCommand(recipientB, 'receipts-1')).toMatchObject({
            connection: 'receiver',
            handleId: 'alm-ws-claim-expires-reclaims-recipient-b-send-1'
        });
        const receipt = {
            state: 'acknowledged',
            receiptMode: 'receiver',
            expectedRecipientPeerIds: ['sender-session', 'receiver-session'],
            confirmedRecipientPeerIds: ['sender-session', 'receiver-session'],
            unconfirmedRecipientPeerIds: []
        };
        expect(await readTail(recipientB, 'receipts-1', receipt)).toBe(true);
        expect(
            await readTailForEachChange({
                recipe: recipientB,
                from: 'receipts-1',
                observation: receipt,
                changes: toReceiptChanges(receipt.expectedRecipientPeerIds)
            })
        )
            .toEqual([false, false, false, false, false]);
    });

    it('has the receiver receive both claims and no third copy', () => {
        const receiver = findScenario('ws', 'claim-expires-reclaims').receiver;

        expect(toCommandNames(receiver)).toEqual([...PROLOGUE, 'received-1', 'received-2', 'stats']);
        expect(findCommand(receiver, 'received-1')).toMatchObject({ count: 2, absent: false });
        expect(findCommand(receiver, 'received-2')).toMatchObject({ count: 3, absent: true });
    });
});

describe('claim-refused-on-rtc', () => {
    it('reads the rtc exclusive send rejected, refused unsupported with no carrier attempt, and neither recipient receives it', async () => {
        const scenario = findScenario('rtc', 'claim-refused-on-rtc');

        expect(toCommandNames(scenario.sender)).toEqual([
            ...PROLOGUE,
            'storage-counters-connected',
            'send-1',
            'observe-rejected-1',
            'assert-refused-1',
            'assert-unsupported-1',
            'assert-no-attempt-1',
            'stats'
        ]);
        expect(findCommand(scenario.sender, 'send-1')).toMatchObject({
            carrier: 'rtc',
            ownership: 'exclusive',
            resourceId: 'claim-rtc-claim-refused-on-rtc'
        });
        const refusal = { state: 'rejected', failure: { kind: 'refused', reason: 'unsupported' }, attempts: 0 };
        expect(await readTail(scenario.sender, 'observe-rejected-1', refusal)).toBe(true);
        expect(await readTail(scenario.sender, 'observe-rejected-1', { ...refusal, attempts: 1 })).toBe(false);
        for (const recipient of [scenario.receiver, requireRecipientB(scenario)]) {
            expect(toCommandNames(recipient)).toEqual([...PROLOGUE, 'received-1', 'stats']);
            expect(findCommand(recipient, 'received-1')).toMatchObject({ count: 1, absent: true });
        }
    });
});
