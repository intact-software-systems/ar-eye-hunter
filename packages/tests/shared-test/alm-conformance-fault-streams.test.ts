import { describe, expect, it } from 'vitest';

import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import { toOrderingKey } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-ordering-commands.ts';
import type { AlmConformanceStepInput } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import { toScenarioTypeId } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-step-identities.ts';
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
    ['lost-stream-start', ['ws', 'rtc']],
    ['lost-stream-start-bounded', ['rtc']],
    ['seeded-jitter-stream', ['ws']]
] as const;
const STREAM_CELLS = [
    ['seeded-loss-stream', 'ws'],
    ['seeded-loss-stream', 'rtc'],
    ['seeded-jitter-stream', 'ws']
] as const;
const LOST_START_CARRIERS = ['ws', 'rtc'] as const;
/** The latest a bounded hold ends after the gap: every renewal interval at the most a stretch may be. */
const HOLD_END_MS = AL_MESSAGE_RESOURCE_LIMITS.gapRenewalIntervalsMs.reduce((sum, intervalMs) => sum + intervalMs, 0) *
    AL_MESSAGE_RESOURCE_LIMITS.gapRenewalMaxStretch;

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

/** The sends of the cell's own type: a cue travels on a type of its own. */
function toSends(recipe: RallarBlackBoxTestRecipe): readonly RallarBlackBoxTestMessagesSendCommand[] {
    return recipe.commands
        .filter((command): command is RallarBlackBoxTestMessagesSendCommand => command.kind === 'messages.send')
        .filter((send) => !send.typeId.endsWith('-cues'));
}

/** Each named command's place in the recipe, so a test reads the order of the steps it names. */
function toPlaces(recipe: RallarBlackBoxTestRecipe, names: readonly string[]): readonly number[] {
    const all = toNames(recipe);
    return names.map((name) => all.indexOf(name));
}

/** A cue's command, named under the cell's cue type rather than the cell's own prefix. */
function findCueCommand(recipe: RallarBlackBoxTestRecipe, name: string): RallarBlackBoxTestCommand {
    const command = recipe.commands.find((candidate) => candidate.commandId?.endsWith(`-${name}`) === true);
    if (command === undefined) {
        throw new Error(`${recipe.recipeId} has no ${name}.`);
    }
    return command;
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

    it.each([
        ...STREAM_CELLS,
        ...LOST_START_CARRIERS.map((carrier) => ['lost-stream-start', carrier] as const),
        ['lost-stream-start-bounded', 'rtc'] as const
    ])(
        '%s over %s sends only receipted at-least-once sends on its own track, in sequence',
        (key, carrier) => {
            const cell = requireCell(key, carrier);
            const sends = toSends(cell.sender);

            expect(sends.length).toBe(key.startsWith('lost-stream-start') ? 3 : STREAM_SENDS);
            sends.forEach((send, index) => {
                expect(send).toMatchObject({
                    ack: 'receiver',
                    reliability: 'at-least-once',
                    orderingKey: toOrderingKey(toSenderStep(carrier, key)),
                    seq: index + 1,
                    payload: { marker: cell.scenarioId, seq: index + 1 }
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

    it('seeded-jitter-stream holds send 2 alone by its message id until send 3 left the page and the jitter\'s longest delay passed, then releases it, before the gap NACK it reveals', () => {
        const sender = requireCell('seeded-jitter-stream', 'ws').sender;
        const places = toPlaces(sender, [
            'jitter-arm',
            'send-1',
            'assert-sent-1',
            'hold-ws',
            'send-2',
            'hold-message-2-ws',
            'release-ws',
            'send-3',
            'assert-sent-3',
            'frame-delay-3',
            'release-message-2-ws',
            'send-4',
            'send-20',
            'gap-nack',
            'jitter-release'
        ]);
        const held = { msgId: `{resultCache.${sender.recipeId}-send-2.value.msgId}` };

        expect(places.every((place) => place >= 0), JSON.stringify(places)).toBe(true);
        expect([...places].sort((left, right) => left - right)).toEqual(places);
        expect(findCommand(sender, 'hold-message-2-ws')).toMatchObject({
            kind: 'fault.inject',
            carrier: 'ws',
            match: held,
            action: 'not-ready',
            remaining: 'until-cleared'
        });
        expect(findCommand(sender, 'release-message-2-ws')).toMatchObject({ kind: 'fault.inject', match: held, remaining: 0 });
        // The jitter delays a frame by at most its longest delay, so send 3 reached the socket before send 2 can.
        expect(findCommand(sender, 'frame-delay-3')).toMatchObject({ kind: 'wait', absent: true, timeoutMs: 80 });
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

    it.each(LOST_START_CARRIERS)(
        'lost-stream-start over %s holds send 1 by its message id until the sender admitted a gap NACK about the track and committed send 1\'s repair, then reads every handle acknowledged',
        (carrier) => {
            const sender = requireCell('lost-stream-start', carrier).sender;
            const places = toPlaces(sender, [
                `hold-${carrier}`,
                'send-1',
                `hold-message-1-${carrier}`,
                `release-${carrier}`,
                'send-2',
                'send-3',
                'gap-nack',
                'repair-dispatch-1',
                `release-message-1-${carrier}`,
                'assert-reached-1',
                'assert-reached-2',
                'assert-reached-3'
            ]);
            const hold = carrier === 'ws' ? 'not-ready' : 'drop';

            expect(places.every((place) => place >= 0)).toBe(true);
            expect([...places].sort((left, right) => left - right)).toEqual(places);
            expect(findCommand(sender, `hold-message-1-${carrier}`)).toMatchObject({
                carrier,
                match: { msgId: `{resultCache.${sender.recipeId}-send-1.value.msgId}` },
                action: hold,
                remaining: 'until-cleared'
            });
            expect(findCommand(sender, `release-message-1-${carrier}`)).toMatchObject({
                carrier,
                match: { msgId: `{resultCache.${sender.recipeId}-send-1.value.msgId}` },
                remaining: 0
            });
            expect(sender.commands.filter((command) => command.kind === 'fault.inject').every((fault) => fault.action === hold))
                .toBe(true);
            expect(findCommand(sender, 'gap-nack')).toMatchObject({
                kind: 'wait',
                match: {
                    kind: 'diagnostic',
                    topic: 'rallar.browser.alm.outbound_diagnostics',
                    contains: `"nackReason":"gap","nackOrderingKey":"${toOrderingKey(toSenderStep(carrier, 'lost-stream-start'))}:`
                }
            });
            expect(findCommand(sender, 'gap-nack')).not.toHaveProperty('absent');
            const step = toSenderStep(carrier, 'lost-stream-start');
            expect(findCommand(sender, 'repair-dispatch-1')).toMatchObject({
                kind: 'wait',
                match: {
                    kind: 'diagnostic',
                    topic: 'rallar.browser.alm.outbound_diagnostics',
                    contains: `"msgId":"{resultCache.${sender.recipeId}-send-1.value.msgId}",` +
                        `"typeId":"${toScenarioTypeId(step)}","origin":"repair"`
                }
            });
            expect(findCommand(sender, 'repair-dispatch-1')).not.toHaveProperty('absent');
            for (const seq of [1, 2, 3]) {
                expect(findCommand(sender, `observe-acknowledged-${seq}`)).toMatchObject({ state: ['acknowledged'] });
            }
            expect(toNames(sender).filter((name) => name.startsWith('observe-') && !name.startsWith('observe-admitted-')))
                .toEqual(['observe-acknowledged-1', 'observe-acknowledged-2', 'observe-acknowledged-3']);
        }
    );

    it.each(LOST_START_CARRIERS)(
        'lost-stream-start over %s reads three arrivals in sequence order, no fourth, and no send refused as before the track\'s entry',
        (carrier) => {
            const receiver = requireCell('lost-stream-start', carrier).receiver;
            const track = `"trackKey":"${toOrderingKey(toSenderStep(carrier, 'lost-stream-start'))}:`;

            expect(receiver.commands.filter((command) => command.kind === 'messages.received')).toMatchObject([
                { count: 3, absent: false, ascendingBy: 'seq' },
                { count: 4, absent: true }
            ]);
            expect(receiver.commands.filter((command) => command.kind === 'wait')).toEqual([
                findCommand(receiver, 'no-before-entry')
            ]);
            expect(findCommand(receiver, 'no-before-entry')).toMatchObject({
                kind: 'wait',
                absent: true,
                match: {
                    kind: 'diagnostic',
                    topic: 'rallar.browser.alm.inbound_diagnostics',
                    contains: track,
                    payloadFields: { 'data.kind': 'ordering-position', 'data.status': 'before-entry' }
                }
            });
            const [first] = toPlaces(receiver, ['received-3']);
            expect(toPlaces(receiver, ['received-3', 'received-4', 'no-before-entry'])).toEqual([first, first + 1, first + 2]);
        }
    );

    it('lost-stream-start-bounded holds send 1 by its message id past the receiver\'s entry, which the receiver cues, then reads handle 1 failed', () => {
        const sender = requireCell('lost-stream-start-bounded', 'rtc').sender;
        const cueReceived = findCueCommand(sender, 'cue-entered-received');
        const listen = sender.commands.filter((command) => command.metadata?.cellArming === 'cue-subscription');
        const names = toNames(sender);
        const places = [
            names.indexOf('hold-rtc'),
            names.indexOf('send-1'),
            names.indexOf('hold-message-1-rtc'),
            names.indexOf('release-rtc'),
            names.indexOf('send-2'),
            names.indexOf('send-3'),
            names.indexOf('gap-nack'),
            sender.commands.indexOf(cueReceived),
            names.indexOf('release-message-1-rtc'),
            names.indexOf('observe-failed-1')
        ];

        expect(places.every((place) => place >= 0)).toBe(true);
        expect([...places].sort((left, right) => left - right)).toEqual(places);
        expect(listen.map((command) => command.kind)).toEqual(['messages.send', 'messages.observe']);
        const [listenAt] = listen.map((command) => sender.commands.indexOf(command));
        expect(listen.map((command) => sender.commands.indexOf(command))).toEqual([listenAt, listenAt + 1]);
        expect(listenAt + 1).toBeLessThan(places[0]);
        expect(findCommand(sender, 'hold-message-1-rtc')).toMatchObject({
            carrier: 'rtc',
            match: { msgId: `{resultCache.${sender.recipeId}-send-1.value.msgId}` },
            action: 'drop',
            remaining: 'until-cleared'
        });
        expect(findCommand(sender, 'release-message-1-rtc')).toMatchObject({
            carrier: 'rtc',
            match: { msgId: `{resultCache.${sender.recipeId}-send-1.value.msgId}` },
            remaining: 0
        });
        expect(findCommand(sender, 'gap-nack')).toMatchObject({
            kind: 'wait',
            match: {
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.outbound_diagnostics',
                contains: `"nackReason":"gap","nackOrderingKey":"${toOrderingKey(toSenderStep('rtc', 'lost-stream-start-bounded'))}:`
            }
        });
        expect(cueReceived).toMatchObject({
            kind: 'wait',
            match: { kind: 'message', equals: { marker: 'lost-stream-start-bounded-cues', carrier: 'rtc', cue: 'entered' } }
        });
        expect(cueReceived).not.toHaveProperty('absent');
        expect(cueReceived.timeoutMs).toBeGreaterThan(HOLD_END_MS);
        expect(findCommand(sender, 'observe-failed-1')).toMatchObject({
            kind: 'messages.observe',
            state: ['failed'],
            timeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
        });
        expect(names.filter((name) => name.startsWith('observe-') && !name.startsWith('observe-admitted-')))
            .toEqual(['observe-failed-1']);
    });

    it('lost-stream-start-bounded reads the hold\'s entry at 2 after prior 1, then 2 and 3 in order, cues, no third, and send 1 refused as before the entry', () => {
        const receiver = requireCell('lost-stream-start-bounded', 'rtc').receiver;
        const track = `"trackKey":"${toOrderingKey(toSenderStep('rtc', 'lost-stream-start-bounded'))}:`;
        const entered = findCommand(receiver, 'entered-2');
        const cueSend = findCueCommand(receiver, 'cue-entered');
        const names = toNames(receiver);
        const first = names.indexOf('entered-2');

        expect(first).toBeGreaterThanOrEqual(0);
        expect([names.indexOf('received-2'), receiver.commands.indexOf(cueSend), names.indexOf('received-3'), names.indexOf('before-entry-1')])
            .toEqual([first + 1, first + 2, first + 4, first + 5]);
        expect(entered).toMatchObject({
            kind: 'wait',
            match: {
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.inbound_diagnostics',
                contains: track,
                payloadFields: { 'data.kind': 'ordering-position', 'data.status': 'entered', 'data.priorSeq': 1 }
            }
        });
        expect(entered).not.toHaveProperty('absent');
        expect(entered.timeoutMs).toBeGreaterThan(HOLD_END_MS);
        expect(receiver.commands.filter((command) => command.kind === 'messages.received')).toMatchObject([
            { count: 2, absent: false, ascendingBy: 'seq' },
            { count: 3, absent: true }
        ]);
        expect(cueSend).toMatchObject({
            kind: 'messages.send',
            carrier: 'ws',
            payload: { marker: 'lost-stream-start-bounded-cues', carrier: 'rtc', cue: 'entered' }
        });
        expect(findCommand(receiver, 'before-entry-1')).toMatchObject({
            kind: 'wait',
            match: {
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.inbound_diagnostics',
                contains: track,
                payloadFields: { 'data.kind': 'ordering-position', 'data.status': 'before-entry', 'data.priorSeq': 0 }
            }
        });
        expect(findCommand(receiver, 'before-entry-1')).not.toHaveProperty('absent');
    });
});
