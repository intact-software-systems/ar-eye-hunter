import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import { toOrderingKey } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-ordering-commands.ts';
import type { AlmConformanceStepInput } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

type Carrier = (typeof ALM_CONFORMANCE_CARRIERS)[number];

const STREAM_SENDS = 20;
const CELL_CARRIERS = [
    ['seeded-loss-stream', ['ws', 'rtc']],
    ['lost-stream-start', ['rtc']],
    ['seeded-jitter-stream', ['ws']]
] as const;
const CELLS = CELL_CARRIERS.flatMap(([key, carriers]) => carriers.map((carrier) => [key, carrier] as const));
const STREAM_CELLS = CELLS.filter(([key]) => key !== 'lost-stream-start');

function findCell(key: string, carrier: Carrier): AlmConformanceScenario | undefined {
    return createAlmConformanceRecipes(toConformanceInput(carrier)).find((scenario) => scenario.scenarioKey === key);
}

function requireCell(key: string, carrier: Carrier): AlmConformanceScenario {
    const cell = findCell(key, carrier);
    if (cell === undefined) {
        throw new Error(`Missing ${key} over ${carrier}.`);
    }
    return cell;
}

/** A recipe's command names in order, without the recipe's own prefix. */
function toNames(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    return recipe.commands.map((command) => (command.commandId ?? '').replace(`${recipe.recipeId}-`, ''));
}

function findCommand(recipe: RallarBlackBoxTestRecipe, name: string): RallarBlackBoxTestCommand {
    const command = recipe.commands.find((candidate) => candidate.commandId === `${recipe.recipeId}-${name}`);
    if (command === undefined) {
        throw new Error(`${recipe.recipeId} has no ${name}.`);
    }
    return command;
}

function toSends(recipe: RallarBlackBoxTestRecipe): readonly RallarBlackBoxTestMessagesSendCommand[] {
    return recipe.commands.filter((command): command is RallarBlackBoxTestMessagesSendCommand => command.kind === 'messages.send');
}

/** Each named command's place in the recipe, so a test reads the order of the steps it names. */
function toPlaces(recipe: RallarBlackBoxTestRecipe, names: readonly string[]): readonly number[] {
    const all = toNames(recipe);
    return names.map((name) => all.indexOf(name));
}

function toSenderStep(carrier: Carrier, key: string): AlmConformanceStepInput {
    return {
        input: toConformanceInput(carrier),
        scenarioId: 'seeded-loss-stream',
        scenarioKey: key,
        role: 'sender',
        roles: ['sender', 'receiver'],
        messages: {},
        connect: undefined
    };
}

describe('ALM fault stream cells', () => {
    it.each(CELL_CARRIERS)('%s runs on exactly %j, in the full scope of the two-agent family', (key, carriers) => {
        const present = ALM_CONFORMANCE_CARRIERS.filter((carrier) => findCell(key, carrier) !== undefined);

        expect(present).toEqual(carriers);
        for (const carrier of carriers) {
            expect(requireCell(key, carrier)).toMatchObject({
                tags: ['full'],
                laneFamily: 'two-agent',
                roles: ['sender', 'receiver']
            });
        }
    });

    it.each(CELLS)('%s over %s sends only receipted at-least-once sends on its own track, in sequence', (key, carrier) => {
        const sends = toSends(requireCell(key, carrier).sender);

        expect(sends.length).toBe(key === 'lost-stream-start' ? 3 : STREAM_SENDS);
        sends.forEach((send, index) => {
            expect(send).toMatchObject({
                ack: 'receiver',
                reliability: 'at-least-once',
                orderingKey: toOrderingKey(toSenderStep(carrier, key)),
                seq: index + 1,
                payload: { marker: key, seq: index + 1 }
            });
        });
    });

    it.each(STREAM_CELLS)('%s over %s settles every send acknowledged', (key, carrier) => {
        const sender = requireCell(key, carrier).sender;
        const settles = Array.from({ length: STREAM_SENDS }, (_, index) => `assert-acknowledged-${index + 1}`);
        const places = toPlaces(sender, settles);

        expect(places.every((place) => place >= 0)).toBe(true);
        expect([...places].sort((left, right) => left - right)).toEqual(places);
        for (const settle of settles) {
            expect(findCommand(sender, settle)).toMatchObject({ kind: 'assert', operator: 'equals', expected: 'acknowledged' });
        }
    });

    it.each(['ws', 'rtc'] as const)(
        'seeded-loss-stream over %s holds its loss until the last send left the page, and recovers after its release',
        (carrier) => {
            const sender = requireCell('seeded-loss-stream', carrier).sender;
            const places = toPlaces(sender, [
                'loss-arm',
                `send-${STREAM_SENDS}`,
                `assert-sent-${STREAM_SENDS}`,
                'loss-release',
                'assert-loss-dropped',
                `observe-acknowledged-${STREAM_SENDS}`
            ]);

            expect(places.every((place) => place >= 0)).toBe(true);
            expect([...places].sort((left, right) => left - right)).toEqual(places);
            expect(toPlaces(sender, ['observe-acknowledged-2'])[0]).toBeGreaterThan(places[4]);
        }
    );

    it.each(STREAM_CELLS)('%s over %s claims twenty arrivals in sequence order and no twenty-first', (key, carrier) => {
        const receiver = requireCell(key, carrier).receiver;

        expect(receiver.commands.filter((command) => command.kind === 'messages.received')).toMatchObject([
            { count: STREAM_SENDS, ascendingBy: 'seq' },
            { count: STREAM_SENDS + 1, absent: true }
        ]);
        expect(findCommand(receiver, `received-${STREAM_SENDS}`)).not.toHaveProperty('absent', true);
        expect(findCommand(receiver, `received-${STREAM_SENDS + 1}`)).not.toHaveProperty('ascendingBy');
    });

    it.each(['ws', 'rtc'] as const)('seeded-loss-stream over %s proves its seeded loss dropped a frame', (carrier) => {
        const sender = requireCell('seeded-loss-stream', carrier).sender;
        const arm = findCommand(sender, 'loss-arm');
        const release = findCommand(sender, 'loss-release');
        const typeId = `alm.conformance.${carrier}.seeded-loss-stream`;

        expect(arm).toMatchObject({ kind: 'fault.inject', carrier, match: { typeId }, faultId: `loss-${carrier}-${typeId}` });
        expect(arm).toMatchObject({
            action: { loss: { ratio: expect.any(Number), seed: expect.any(Number) } },
            remaining: 'until-cleared'
        });
        expect(release).toMatchObject({ kind: 'fault.inject', carrier, faultId: `loss-${carrier}-${typeId}`, remaining: 0 });
        expect(findCommand(sender, 'assert-loss-dropped')).toEqual(expect.objectContaining({
            kind: 'assert',
            source: `resultCache.${release.commandId}.value.acted.drop`,
            operator: 'gte',
            expected: 1
        }));
        expect(toPlaces(sender, ['loss-release', 'assert-loss-dropped'])).toEqual([
            sender.commands.indexOf(release),
            sender.commands.indexOf(release) + 1
        ]);
    });

    it('seeded-loss-stream arms its loss before the first send over ws', () => {
        const places = toPlaces(requireCell('seeded-loss-stream', 'ws').sender, ['loss-arm', 'send-1']);

        expect(places[0]).toBeGreaterThanOrEqual(0);
        expect(places[0]).toBeLessThan(places[1]);
    });

    it('seeded-loss-stream enters its track over rtc before the loss: send 1 is acknowledged, then the loss is armed', () => {
        const places = toPlaces(requireCell('seeded-loss-stream', 'rtc').sender, [
            'send-1',
            'assert-acknowledged-1',
            'loss-arm',
            'send-2'
        ]);

        expect(places.every((place) => place >= 0)).toBe(true);
        expect([...places].sort((left, right) => left - right)).toEqual(places);
    });

    it('seeded-jitter-stream delays every data frame by a seeded 0 to 80 ms and proves at least ten were delayed', () => {
        const sender = requireCell('seeded-jitter-stream', 'ws').sender;
        const release = findCommand(sender, 'jitter-release');
        const typeId = 'alm.conformance.ws.seeded-jitter-stream';

        expect(findCommand(sender, 'jitter-arm')).toMatchObject({
            kind: 'fault.inject',
            carrier: 'ws',
            match: { typeId },
            action: { jitter: { minDelayMs: 0, maxDelayMs: 80, seed: expect.any(Number) } },
            remaining: 'until-cleared'
        });
        expect(release).toMatchObject({ kind: 'fault.inject', carrier: 'ws', remaining: 0 });
        expect(findCommand(sender, 'assert-jitter-delayed')).toEqual(expect.objectContaining({
            kind: 'assert',
            source: `resultCache.${release.commandId}.value.acted.delay`,
            operator: 'gte',
            expected: 10
        }));
        expect(toPlaces(sender, ['jitter-arm', 'send-1'])[0]).toBeLessThan(toPlaces(sender, ['jitter-arm', 'send-1'])[1]);
    });

    it('lost-stream-start holds send 1 by its message id, never by a ratio, until sends 2 and 3 were acknowledged', () => {
        const sender = requireCell('lost-stream-start', 'rtc').sender;
        const places = toPlaces(sender, [
            'hold-rtc',
            'send-1',
            'hold-message-1-rtc',
            'release-rtc',
            'send-2',
            'assert-reached-2',
            'send-3',
            'assert-reached-3',
            'release-message-1-rtc',
            'observe-failed-1',
            'assert-receipt-exhausted-1'
        ]);
        const faults = sender.commands.filter((command) => command.kind === 'fault.inject');

        expect(places.every((place) => place >= 0)).toBe(true);
        expect([...places].sort((left, right) => left - right)).toEqual(places);
        expect(findCommand(sender, 'hold-message-1-rtc')).toMatchObject({
            match: { msgId: `{resultCache.${sender.recipeId}-send-1.value.msgId}` },
            action: 'drop',
            remaining: 'until-cleared'
        });
        expect(faults.every((fault) => fault.action === 'drop')).toBe(true);
        expect(findCommand(sender, 'assert-receipt-exhausted-1')).toEqual(expect.objectContaining({
            kind: 'assert',
            source: `resultCache.${sender.recipeId}-observe-failed-1.value.failure.kind`,
            operator: 'equals',
            expected: 'receipt-exhausted'
        }));
    });

    it('lost-stream-start reads two arrivals in order, the first send refused as before the entry, and no third', () => {
        const receiver = requireCell('lost-stream-start', 'rtc').receiver;
        const refusal = findCommand(receiver, 'before-entry-1');

        expect(receiver.commands.filter((command) => command.kind === 'messages.received')).toMatchObject([
            { count: 2, ascendingBy: 'seq' },
            { count: 3, absent: true }
        ]);
        expect(refusal).toMatchObject({
            kind: 'wait',
            match: {
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.inbound_diagnostics',
                contains: `"trackKey":"${toOrderingKey(toSenderStep('rtc', 'lost-stream-start'))}:`,
                payloadFields: { 'data.kind': 'ordering-position', 'data.status': 'before-entry', 'data.seq': 1 }
            }
        });
        expect(refusal).not.toHaveProperty('absent');
        expect(toPlaces(receiver, ['received-2', 'before-entry-1', 'received-3'])).toEqual(
            [...toPlaces(receiver, ['received-2', 'before-entry-1', 'received-3'])].sort((left, right) => left - right)
        );
    });
});
