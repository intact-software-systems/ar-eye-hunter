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
    ['seeded-loss-unreceipted-stream', ['ws']],
    ['lost-stream-start', ['rtc']],
    ['seeded-jitter-stream', ['ws']]
] as const;
const STREAM_CELLS = [
    ['seeded-loss-stream', 'ws'],
    ['seeded-loss-stream', 'rtc'],
    ['seeded-jitter-stream', 'ws']
] as const;

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
        scenarioId: 'lost-stream-start',
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

    it.each([...STREAM_CELLS, ['lost-stream-start', 'rtc'] as const])(
        '%s over %s sends only receipted at-least-once sends on its own track, in sequence',
        (key, carrier) => {
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
        }
    );

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

    it.each([...STREAM_CELLS, ['seeded-loss-unreceipted-stream', 'ws']] as const)(
        '%s over %s claims twenty arrivals in sequence order and no twenty-first',
        (key, carrier) => {
            const receiver = requireCell(key, carrier).receiver;

            expect(receiver.commands.filter((command) => command.kind === 'messages.received')).toMatchObject([
                { count: STREAM_SENDS, ascendingBy: 'seq' },
                { count: STREAM_SENDS + 1, absent: true }
            ]);
            expect(findCommand(receiver, `received-${STREAM_SENDS}`)).not.toHaveProperty('absent', true);
            expect(findCommand(receiver, `received-${STREAM_SENDS + 1}`)).not.toHaveProperty('ascendingBy');
        }
    );

    it.each(['ws', 'rtc'] as const)(
        'seeded-loss-stream over %s holds its loss until the last send is admitted, and recovers after its release',
        (carrier) => {
            const sender = requireCell('seeded-loss-stream', carrier).sender;
            const places = toPlaces(sender, [
                'loss-arm',
                `send-${STREAM_SENDS}`,
                `assert-admitted-${STREAM_SENDS}`,
                'loss-release',
                'assert-loss-dropped',
                `observe-acknowledged-${STREAM_SENDS}`
            ]);

            expect(places.every((place) => place >= 0)).toBe(true);
            expect([...places].sort((left, right) => left - right)).toEqual(places);
            expect(toPlaces(sender, ['observe-acknowledged-2'])[0]).toBeGreaterThan(places[4]);
        }
    );

    it.each(['ws', 'rtc'] as const)('seeded-loss-stream over %s proves its seeded loss dropped a frame', (carrier) => {
        const sender = requireCell('seeded-loss-stream', carrier).sender;
        const arm = findCommand(sender, 'loss-arm');
        const release = findCommand(sender, 'loss-release');
        const typeId = `alm.conformance.${carrier}.seeded-loss-stream`;

        expect(arm).toMatchObject({ kind: 'fault.inject', carrier, match: { typeId }, faultId: `loss-${carrier}-${typeId}` });
        expect(arm).toMatchObject({ action: { loss: { ratio: 0.25, seed: 7 } }, remaining: 'until-cleared' });
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

    it('seeded-loss-unreceipted-stream sends twenty unreceipted at-least-once sends on its own track, in sequence', () => {
        const sends = toSends(requireCell('seeded-loss-unreceipted-stream', 'ws').sender);

        expect(sends.length).toBe(STREAM_SENDS);
        sends.forEach((send, index) => {
            expect(send).toMatchObject({
                ack: 'none',
                reliability: 'at-least-once',
                orderingKey: toOrderingKey(toSenderStep('ws', 'seeded-loss-unreceipted-stream')),
                seq: index + 1,
                payload: { marker: 'seeded-loss-unreceipted-stream', seq: index + 1 }
            });
        });
    });

    it('seeded-loss-unreceipted-stream holds its loss over the first nineteen sends and sends the twentieth after the release', () => {
        const sender = requireCell('seeded-loss-unreceipted-stream', 'ws').sender;
        const typeId = 'alm.conformance.ws.seeded-loss-unreceipted-stream';
        const release = findCommand(sender, 'loss-release');
        const places = toPlaces(sender, [
            'loss-arm',
            'send-1',
            `send-${STREAM_SENDS - 1}`,
            `assert-admitted-${STREAM_SENDS - 1}`,
            'loss-release',
            'assert-loss-dropped',
            `send-${STREAM_SENDS}`,
            `assert-admitted-${STREAM_SENDS}`
        ]);

        expect(places.every((place) => place >= 0)).toBe(true);
        expect([...places].sort((left, right) => left - right)).toEqual(places);
        expect(findCommand(sender, 'loss-arm')).toMatchObject({
            kind: 'fault.inject',
            carrier: 'ws',
            match: { typeId },
            faultId: `loss-ws-${typeId}`,
            action: { loss: { ratio: 0.25, seed: 7 } },
            remaining: 'until-cleared'
        });
        expect(release).toMatchObject({ kind: 'fault.inject', carrier: 'ws', faultId: `loss-ws-${typeId}`, remaining: 0 });
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
        expect(toNames(sender).filter((name) => name.startsWith('observe-acknowledged-'))).toEqual([]);
    });

    it('seeded-jitter-stream delays every data frame by a seeded 0 to 80 ms and proves every send met a delay', () => {
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
            expected: STREAM_SENDS
        }));
        expect(toPlaces(sender, ['jitter-arm', 'send-1'])[0]).toBeLessThan(toPlaces(sender, ['jitter-arm', 'send-1'])[1]);
        expect(toPlaces(sender, ['jitter-release', 'assert-jitter-delayed'])).toEqual([
            sender.commands.indexOf(release),
            sender.commands.indexOf(release) + 1
        ]);
    });

    it('seeded-jitter-stream proves frames reached the server out of order: the sender admitted a gap NACK about its track', () => {
        const sender = requireCell('seeded-jitter-stream', 'ws').sender;
        const reordered = findCommand(sender, 'gap-nack');

        expect(reordered).toMatchObject({
            kind: 'wait',
            match: {
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.outbound_diagnostics',
                contains: `"nackReason":"gap","nackOrderingKey":"${toOrderingKey(toSenderStep('ws', 'seeded-jitter-stream'))}:`
            }
        });
        expect(reordered).not.toHaveProperty('absent');
        expect(toPlaces(sender, ['jitter-arm', 'gap-nack', 'jitter-release'])).toEqual(
            [...toPlaces(sender, ['jitter-arm', 'gap-nack', 'jitter-release'])].sort((left, right) => left - right)
        );
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

    it('lost-stream-start reads two arrivals in order, its entry at the second send, the first refused as before it, and no third', () => {
        const receiver = requireCell('lost-stream-start', 'rtc').receiver;
        const track = `"trackKey":"${toOrderingKey(toSenderStep('rtc', 'lost-stream-start'))}:`;
        const position = { kind: 'diagnostic', topic: 'rallar.browser.alm.inbound_diagnostics', contains: track };
        const steps = ['received-2', 'entered-2', 'before-entry-1', 'received-3'];

        expect(receiver.commands.filter((command) => command.kind === 'messages.received')).toMatchObject([
            { count: 2, ascendingBy: 'seq' },
            { count: 3, absent: true }
        ]);
        expect(findCommand(receiver, 'entered-2')).toMatchObject({
            kind: 'wait',
            match: { ...position, payloadFields: { 'data.kind': 'ordering-position', 'data.status': 'entered', 'data.priorSeq': 1 } }
        });
        expect(findCommand(receiver, 'before-entry-1')).toMatchObject({
            kind: 'wait',
            match: { ...position, payloadFields: { 'data.kind': 'ordering-position', 'data.status': 'before-entry', 'data.priorSeq': 0 } }
        });
        expect(findCommand(receiver, 'entered-2')).not.toHaveProperty('absent');
        expect(findCommand(receiver, 'before-entry-1')).not.toHaveProperty('absent');
        expect(toPlaces(receiver, steps)).toEqual([...toPlaces(receiver, steps)].sort((left, right) => left - right));
        expect(toPlaces(receiver, steps).every((place) => place >= 0)).toBe(true);
    });
});
