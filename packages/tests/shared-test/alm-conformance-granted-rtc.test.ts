import {
    describe,
    expect,
    it
} from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { CONFORMANCE_PRINCIPAL_IDS, toConformanceInput } from './alm-conformance-test-input.ts';

const GRANTED_TOPIC_ID = 'room.alm-conformance-granted';
const INBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.inbound_diagnostics';

function toGrantedRtcScenario(scenarioId: string): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(toConformanceInput('rtc'))
        .find((candidate) => candidate.scenarioId === scenarioId);
    if (scenario === undefined) {
        throw new Error(`${scenarioId} is not planned over rtc.`);
    }
    return scenario;
}

/** Every command a recipe runs, the children of each poll included. */
function toFlatCommands(recipe: RallarBlackBoxTestRecipe | undefined): readonly RallarBlackBoxTestCommand[] {
    const flatten = (commands: readonly RallarBlackBoxTestCommand[]): readonly RallarBlackBoxTestCommand[] =>
        commands.flatMap((command) => command.kind === 'loop' ? [command, ...flatten(command.commands)] : [command]);
    return flatten(recipe?.commands ?? []);
}

function toGrantedSends(recipe: RallarBlackBoxTestRecipe): readonly RallarBlackBoxTestCommand[] {
    return toFlatCommands(recipe).filter((command) =>
        command.kind === 'messages.send' && !('replayOnCarrier' in command) && command.topicId === GRANTED_TOPIC_ID
    );
}

function toRewriteFaults(recipe: RallarBlackBoxTestRecipe): readonly RallarBlackBoxTestCommand[] {
    return toFlatCommands(recipe).filter((command) =>
        command.kind === 'fault.inject' && command.carrier === 'rtc' && typeof command.action === 'object' &&
        'rewrite' in command.action
    );
}

function toOutcomeWaits(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    return toFlatCommands(recipe).flatMap((command) =>
        command.kind === 'wait' && command.match.topic === INBOUND_DIAGNOSTICS_TOPIC && command.match.contains !== undefined
            ? [command.match.contains]
            : []
    );
}

/** The `[field, expected]` of each assertion a refusal poll makes on the observed handle. */
function toVerdictFacts(recipe: RallarBlackBoxTestRecipe): readonly (readonly [string, unknown])[] {
    return toFlatCommands(recipe).flatMap((command) =>
        command.kind === 'assert' && command.source.includes('-refusal-observe.value.')
            ? [[command.source.split('.value.')[1]!, command.expected] as const]
            : []
    );
}

describe('the granted rtc cells', () => {
    it('plans the granted family over rtc alone, every cell full-only and the forged sender on three agents', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const granted = createAlmConformanceRecipes(toConformanceInput(carrier))
                .filter(({ scenarioId }) => scenarioId.startsWith('granted-rtc-'));
            expect(granted.map(({ scenarioKey, laneFamily }) => [scenarioKey, laneFamily]), carrier).toEqual(
                carrier === 'rtc'
                    ? [
                        ['granted-rtc-delivered', 'two-agent'],
                        ['granted-rtc-missing-proof', 'two-agent'],
                        ['granted-rtc-lane-refused', 'two-agent'],
                        ['granted-rtc-receipted-unsupported', 'two-agent'],
                        ['granted-rtc-forged-sender', 'three-agent']
                    ]
                    : []
            );
            expect(granted.every(({ tags }) => tags.length === 1 && tags[0] === 'full')).toBe(true);
        }
    });

    it('creates a cell that names a principal only for a caller that names each of them, so a hosted manifest has none', () => {
        const namesPrincipal = ({ scenarioId }: AlmConformanceScenario) => scenarioId.startsWith('granted-rtc-') || scenarioId.startsWith('subscription-');
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const unnamed = createAlmConformanceRecipes({ ...toConformanceInput(carrier), principalIdsByRole: {} });
            const named = createAlmConformanceRecipes(toConformanceInput(carrier));

            expect(unnamed.filter(namesPrincipal), carrier).toEqual([]);
            expect(unnamed.map(({ scenarioKey }) => scenarioKey), carrier)
                .toEqual(named.filter((scenario) => !namesPrincipal(scenario)).map(({ scenarioKey }) => scenarioKey));
        }
        const pair = createAlmConformanceRecipes({
            ...toConformanceInput('rtc'),
            principalIdsByRole: { sender: CONFORMANCE_PRINCIPAL_IDS.sender, receiver: CONFORMANCE_PRINCIPAL_IDS.receiver }
        });
        expect(pair.filter(namesPrincipal).map(({ scenarioKey }) => scenarioKey)).toEqual([
            'granted-rtc-delivered',
            'granted-rtc-missing-proof',
            'granted-rtc-lane-refused',
            'granted-rtc-receipted-unsupported'
        ]);
    });

    it('states ack on every granted send: none for a publication, receiver for the receipted refusal', () => {
        const acks = [
            'granted-rtc-delivered',
            'granted-rtc-forged-sender',
            'granted-rtc-missing-proof',
            'granted-rtc-lane-refused',
            'granted-rtc-receipted-unsupported'
        ].map((scenarioId) => {
            const scenario = toGrantedRtcScenario(scenarioId);
            const sends = [...toGrantedSends(scenario.sender), ...toGrantedSends(scenario.receiver)];
            return [scenarioId, [...new Set(sends.map((send) => send.kind === 'messages.send' && 'ack' in send ? send.ack : 'unstated'))]];
        });

        expect(acks).toEqual([
            ['granted-rtc-delivered', ['none']],
            ['granted-rtc-forged-sender', ['none']],
            ['granted-rtc-missing-proof', ['none']],
            ['granted-rtc-lane-refused', ['none']],
            ['granted-rtc-receipted-unsupported', ['receiver']]
        ]);
    });

    it('delivers a publication the owner granted and its own election heard over rtc', () => {
        const { sender, receiver } = toGrantedRtcScenario('granted-rtc-delivered');
        const arrival = toFlatCommands(receiver).find((command) =>
            command.kind === 'wait' && command.match.kind === 'message' &&
            command.match.payloadFields?.['data.transport'] === 'rtc'
        );

        expect(toGrantedSends(sender)).toHaveLength(1);
        expect(arrival).toMatchObject({ match: { payloadPath: 'data.payload' } });
        expect(arrival).not.toHaveProperty('match.absent');
        expect(toFlatCommands(receiver).map((command) => command.kind)).toContain('messages.subscribe');
    });

    it('forges the sender as recipient-b, a member that is neither the sender nor the receiver, and releases the hold', () => {
        const scenario = toGrantedRtcScenario('granted-rtc-forged-sender');
        const rewrite = { forgeSender: { principal: CONFORMANCE_PRINCIPAL_IDS['recipient-b'] } };

        expect(toRewriteFaults(scenario.sender)).toEqual([
            expect.objectContaining({ action: { rewrite }, remaining: 'until-cleared' }),
            expect.objectContaining({ action: { rewrite }, remaining: 0 })
        ]);
        expect(CONFORMANCE_PRINCIPAL_IDS['recipient-b']).not.toBe(CONFORMANCE_PRINCIPAL_IDS.sender);
        expect(CONFORMANCE_PRINCIPAL_IDS['recipient-b']).not.toBe(CONFORMANCE_PRINCIPAL_IDS.receiver);
        expect(toOutcomeWaits(scenario.receiver)).toEqual([
            `"typeId":"alm.conformance.rtc.granted-rtc-forged-sender","carrier":"rtc","outcome":"unauthorized","reason":"unauthorized: invalid-signature"`
        ]);
        expect(toFlatCommands(scenario.receiver).some((command) => command.kind === 'wait' && command.absent === true))
            .toBe(true);
        expect(toFlatCommands(scenario.recipientB).map((command) => command.kind)).not.toContain('messages.subscribe');
    });

    it('strips the proof and waits for the receiver to drop the frame unauthorized for its missing proof', () => {
        const scenario = toGrantedRtcScenario('granted-rtc-missing-proof');

        expect(toRewriteFaults(scenario.sender)).toEqual([
            expect.objectContaining({ action: { rewrite: 'strip-proof' }, remaining: 'until-cleared' }),
            expect.objectContaining({ action: { rewrite: 'strip-proof' }, remaining: 0 })
        ]);
        expect(toOutcomeWaits(scenario.receiver)).toEqual([
            `"typeId":"alm.conformance.rtc.granted-rtc-missing-proof","carrier":"rtc","outcome":"unauthorized","reason":"unauthorized: missing-proof"`
        ]);
    });

    it('refuses the subscribe-only receiver\'s rtc publication no-publish-grant and a receipted one unsupported, before any attempt', () => {
        const laneRefused = toGrantedRtcScenario('granted-rtc-lane-refused');
        const receipted = toGrantedRtcScenario('granted-rtc-receipted-unsupported');

        expect(toGrantedSends(laneRefused.sender)).toEqual([]);
        expect(toVerdictFacts(laneRefused.receiver)).toEqual([
            ['failure.kind', 'refused'],
            ['failure.reason', 'no-publish-grant'],
            ['attempts', 0]
        ]);
        expect(toVerdictFacts(receipted.sender)).toEqual([
            ['failure.kind', 'refused'],
            ['failure.reason', 'unsupported'],
            ['attempts', 0]
        ]);
        // The lane cell's receiver opens no granted channel: only the snapshot's grant makes its send a granted one.
        expect(toFlatCommands(laneRefused.receiver).find((command) => command.kind === 'rtc.connect'))
            .not.toHaveProperty('rallar.messageSelector');
    });
});
