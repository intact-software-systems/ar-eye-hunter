import {
    describe,
    expect,
    it
} from 'vitest';

import {
    ALM_CONFORMANCE_CARRIERS,
    type AlmConformanceCarrier
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import { ALM_CONFORMANCE_ROLES } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import {
    createAlmConformanceRecipes,
    toAlmConformanceRoleRecipe,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type {
    RallarBlackBoxTestAssertCommand,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestHttpRequestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { CONFORMANCE_PRINCIPAL_IDS, toConformanceInput } from './alm-conformance-test-input.ts';

const GRANTED_TOPIC_ID = 'room.alm-conformance-granted';
const INBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.inbound_diagnostics';

interface GrantedSend {
    readonly kind: 'messages.send' | 'rtc.send';
    readonly ack: string | undefined;
    readonly reliability: string | undefined;
}

function toGrantedRtcScenarioOver(scenarioId: string, carrier: AlmConformanceCarrier): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(toConformanceInput(carrier))
        .find((candidate) => candidate.scenarioId === scenarioId);
    if (scenario === undefined) {
        throw new Error(`${scenarioId} is not planned over ${carrier}.`);
    }
    return scenario;
}

function toGrantedRtcScenario(scenarioId: string): AlmConformanceScenario {
    return toGrantedRtcScenarioOver(scenarioId, 'rtc');
}

/** Every command a recipe runs, the children of each poll included. */
function toFlatCommands(recipe: RallarBlackBoxTestRecipe | undefined): readonly RallarBlackBoxTestCommand[] {
    const flatten = (commands: readonly RallarBlackBoxTestCommand[]): readonly RallarBlackBoxTestCommand[] =>
        commands.flatMap((command) => command.kind === 'loop' ? [command, ...flatten(command.commands)] : [command]);
    return flatten(recipe?.commands ?? []);
}

/** A granted send through a typed channel, or one through the `messages.rtc` lane entry, whose envelope names the topic. */
function toGrantedSends(recipe: RallarBlackBoxTestRecipe | undefined): readonly GrantedSend[] {
    return toFlatCommands(recipe).flatMap((command): readonly GrantedSend[] => {
        if (command.kind === 'messages.send' && !('replayOnCarrier' in command) && command.topicId === GRANTED_TOPIC_ID) {
            return [{ kind: command.kind, ack: command.ack, reliability: command.reliability }];
        }
        const envelope = command.kind === 'rtc.send' ? command.send : undefined;
        return isJsonRecordValue(envelope) && envelope.topicId === GRANTED_TOPIC_ID
            ? [{ kind: 'rtc.send', ack: String(envelope.ack), reliability: String(envelope.reliability) }]
            : [];
    });
}

/** The receipt counts a publish loop holds every attempt to: each recipient list's length, by its list. */
function toReceiptCounts(
    recipe: RallarBlackBoxTestRecipe | undefined
): Readonly<Record<string, RallarBlackBoxTestAssertCommand['expected']>> {
    return Object.fromEntries(
        toFlatCommands(recipe).flatMap((command) => {
            const list = command.kind === 'assert' ? command.source.match(/\.(\w+)RecipientPeerIds$/)?.[1] : undefined;
            return command.kind === 'assert' && list !== undefined ? [[list, command.expected]] : [];
        })
    );
}

function toObservedStates(recipe: RallarBlackBoxTestRecipe | undefined): readonly (readonly string[])[] {
    return toFlatCommands(recipe).flatMap((command) =>
        command.kind === 'messages.observe' && command.commandId?.includes('publication') === true &&
            command.commandId.includes('-cue-') === false
            ? [command.state]
            : []
    );
}

/** The index of the first command whose id ends with `suffix`, so a test can pin the order of two steps. */
function toStepIndex(recipe: RallarBlackBoxTestRecipe | undefined, suffix: string): number {
    const index = toFlatCommands(recipe).findIndex((command) => command.commandId?.endsWith(suffix) === true);
    if (index < 0) {
        throw new Error(`${recipe?.recipeId} runs no command ending ${suffix}.`);
    }
    return index;
}

function toRequests(recipe: RallarBlackBoxTestRecipe | undefined): readonly RallarBlackBoxTestHttpRequestCommand[] {
    return toFlatCommands(recipe).filter((command): command is RallarBlackBoxTestHttpRequestCommand => command.kind === 'http.request');
}

function toPublicationAbsences(recipe: RallarBlackBoxTestRecipe | undefined): readonly string[] {
    return toFlatCommands(recipe).flatMap((command) =>
        command.kind === 'wait' && command.absent === true && command.match.kind === 'message' && isJsonRecordValue(command.match.equals)
            ? [String(command.match.equals.publication)]
            : []
    );
}

function toRewriteFaults(recipe: RallarBlackBoxTestRecipe): readonly RallarBlackBoxTestCommand[] {
    return toFlatCommands(recipe).filter((command) =>
        command.kind === 'fault.inject' && command.carrier === 'rtc' && typeof command.action === 'object' &&
        'rewrite' in command.action
    );
}

function toOutcomeWaits(recipe: RallarBlackBoxTestRecipe | undefined): readonly string[] {
    return toFlatCommands(recipe).flatMap((command) =>
        command.kind === 'wait' && command.match.topic === INBOUND_DIAGNOSTICS_TOPIC && command.match.contains !== undefined
            ? [command.match.contains]
            : []
    );
}

/** The `[field, expected]` of each assertion a refusal poll makes on the rejected handle its lane send returned. */
function toVerdictFacts(
    recipe: RallarBlackBoxTestRecipe
): readonly (readonly [string, RallarBlackBoxTestAssertCommand['expected']])[] {
    return toFlatCommands(recipe).flatMap((command) =>
        command.kind === 'assert' && command.source.includes('-refusal-send.value.message.')
            ? [[command.source.split('.value.message.')[1]!, command.expected] as const]
            : []
    );
}

describe('the granted rtc cells', () => {
    it('plans the granted family over rtc, the revoked publisher over the fallback carrier too, every cell full-only and the two relay cells last', () => {
        const families = {
            ws: [],
            rtc: [
                ['granted-rtc-delivered', 'two-agent'],
                ['granted-rtc-missing-proof', 'two-agent'],
                ['granted-rtc-publish-refused', 'two-agent'],
                ['granted-rtc-receipted-delivered', 'two-agent'],
                ['granted-rtc-revoked-publisher', 'two-agent'],
                ['granted-rtc-forged-sender', 'three-agent'],
                ['granted-rtc-not-subscribed', 'three-agent'],
                ['granted-rtc-relay-only', 'three-agent'],
                ['granted-rtc-ordered-relay', 'three-agent']
            ],
            'rtc-with-ws-fallback': [['granted-rtc-revoked-publisher', 'two-agent']]
        } as const;
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const granted = createAlmConformanceRecipes(toConformanceInput(carrier))
                .filter(({ scenarioId }) => scenarioId.startsWith('granted-rtc-'));
            expect(granted.map(({ scenarioKey, laneFamily }) => [scenarioKey, laneFamily]), carrier).toEqual(families[carrier]);
            expect(granted.every(({ tags }) => tags.length === 1 && tags[0] === 'full')).toBe(true);
            expect(granted.map(({ scenarioKey }) => scenarioKey)).not.toContain('granted-rtc-receipted-unsupported');
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
            'granted-rtc-publish-refused',
            'granted-rtc-receipted-delivered',
            'granted-rtc-revoked-publisher',
            // The topic subscription cells that grant only the sender's principal and the receiver's.
            'subscription-token-count',
            'subscription-revoke-disconnected'
        ]);
    });

    it('declares in principalRoles exactly the roles every scenario writes as {principal:<role>}', () => {
        const sentinels = Object.fromEntries(ALM_CONFORMANCE_ROLES.map((role) => [role, `principal-sentinel-${role}`]));
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const input = { ...toConformanceInput(carrier), principalIdsByRole: sentinels };
            // A role is declared exactly when creation without it leaves the scenario out.
            const keysWithout = new Map(ALM_CONFORMANCE_ROLES.map((role) => {
                const { [role]: _omitted, ...others } = sentinels;
                const created = createAlmConformanceRecipes({ ...input, principalIdsByRole: others });
                return [role, new Set(created.map(({ scenarioKey }) => scenarioKey))] as const;
            }));
            for (const scenario of createAlmConformanceRecipes(input)) {
                const text = JSON.stringify(scenario);
                const written = ALM_CONFORMANCE_ROLES.filter((role) => text.includes(sentinels[role]!));
                const declared = ALM_CONFORMANCE_ROLES.filter((role) => !keysWithout.get(role)!.has(scenario.scenarioKey));

                expect(declared, `${carrier} ${scenario.scenarioKey}`).toEqual(written);
            }
        }
    });

    it('states its receipt and reliability on every granted send, through the typed channel or the lane entry', () => {
        const unreceipted = 'none/best-effort';
        const receipted = 'all-logical-recipients/at-least-once';
        const deliveries = createAlmConformanceRecipes(toConformanceInput('rtc'))
            .filter(({ scenarioId }) => scenarioId.startsWith('granted-rtc-'))
            .map((scenario) => {
                const sends = scenario.roles.flatMap((role) => toGrantedSends(toAlmConformanceRoleRecipe(scenario, role)));
                return [
                    scenario.scenarioKey,
                    [...new Set(sends.map(({ kind, ack, reliability }) => `${kind} ${String(ack)}/${String(reliability)}`))]
                ];
            });

        expect(deliveries).toEqual([
            ['granted-rtc-delivered', [`messages.send ${unreceipted}`]],
            ['granted-rtc-missing-proof', [`messages.send ${unreceipted}`]],
            ['granted-rtc-publish-refused', [`rtc.send ${unreceipted}`]],
            ['granted-rtc-receipted-delivered', [`messages.send ${receipted}`]],
            ['granted-rtc-revoked-publisher', [`messages.send ${receipted}`]],
            ['granted-rtc-forged-sender', [`messages.send ${unreceipted}`]],
            ['granted-rtc-not-subscribed', [`messages.send ${receipted}`]],
            ['granted-rtc-relay-only', [`messages.send ${unreceipted}`]],
            ['granted-rtc-ordered-relay', [`messages.send ${receipted}`]]
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

    it('asserts recipient-b drops the forged frame for its signature too, before it waits for the cue', () => {
        const recipe = toGrantedRtcScenario('granted-rtc-forged-sender').recipientB!;
        const recipientB = toFlatCommands(recipe);
        const outcome = recipientB.findIndex((command) => command.kind === 'wait' && command.match.topic === INBOUND_DIAGNOSTICS_TOPIC);
        const cue = recipientB.findIndex((command) => command.kind === 'wait' && command.match.kind === 'message');

        expect(toOutcomeWaits(recipe)).toEqual([
            `"typeId":"alm.conformance.rtc.granted-rtc-forged-sender","carrier":"rtc","outcome":"unauthorized","reason":"unauthorized: invalid-signature"`
        ]);
        expect(outcome).toBeGreaterThanOrEqual(0);
        expect(outcome).toBeLessThan(cue);
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

    it('refuses the subscribe-only receiver\'s publication through the messages.rtc lane entry no-publish-grant before any attempt', () => {
        const publishRefused = toGrantedRtcScenario('granted-rtc-publish-refused');
        const laneSends = toFlatCommands(publishRefused.receiver).filter((command) => command.kind === 'rtc.send');

        expect(toGrantedSends(publishRefused.sender)).toEqual([]);
        expect(toFlatCommands(publishRefused.receiver).map((command) => command.kind)).not.toContain('messages.send');
        expect(laneSends).toEqual([expect.objectContaining({ transport: 'messages.rtc', observe: 'rejected' })]);
        expect(toVerdictFacts(publishRefused.receiver)).toEqual([
            ['failure.kind', 'refused'],
            ['failure.reason', 'no-publish-grant'],
            ['attempts', 0]
        ]);
        // The cell's receiver opens no granted channel: only the snapshot's grant makes its send a granted one.
        expect(toFlatCommands(publishRefused.receiver).find((command) => command.kind === 'rtc.connect'))
            .not.toHaveProperty('rallar.messageSelector');
    });

    it('confirms a receipted granted publication over rtc to the one subscribed receiver, nobody outside it', () => {
        const { sender, receiver } = toGrantedRtcScenario('granted-rtc-receipted-delivered');

        expect(toReceiptCounts(sender)).toEqual({ expected: 1, confirmed: 1, outsideAudience: 0 });
        expect(toObservedStates(sender)).toEqual([['acknowledged']]);
        expect(toFlatCommands(receiver).some((command) => command.kind === 'wait' && command.match.payloadFields?.['data.transport'] === 'rtc')).toBe(true);
        expect(toFlatCommands(receiver).map((command) => command.kind)).toContain('messages.subscribe');
    });

    it('counts recipient-b, granted subscribe without an election, outside the receipt while the receiver confirms', () => {
        const { sender, receiver, recipientB } = toGrantedRtcScenario('granted-rtc-not-subscribed');
        const grants = toRequests(receiver).filter(({ request }) => request.path?.includes('/publication-grants/principal-charlie/grant/'));

        expect(toReceiptCounts(sender)).toEqual({ expected: 2, confirmed: 1, outsideAudience: 1 });
        expect(toObservedStates(sender)).toEqual([['acknowledged']]);
        expect(grants.map(({ request }) => request.body)).toEqual([
            { topicId: GRANTED_TOPIC_ID, publish: false, subscribe: true }
        ]);
        expect(toFlatCommands(recipientB).map((command) => command.kind)).not.toContain('messages.subscribe');
        // Its frame is admitted over RTC and, with the absence below, delivered nowhere on its page.
        expect(toOutcomeWaits(recipientB)).toEqual([
            `"typeId":"alm.conformance.rtc.granted-rtc-not-subscribed","carrier":"rtc","outcome":"committed","reason":"admitted"`
        ]);
        expect(toPublicationAbsences(recipientB)).toEqual(['publication']);
        expect(toFlatCommands(receiver).map((command) => command.kind)).toContain('messages.subscribe');
    });

    it.each(['rtc', 'rtc-with-ws-fallback'] as const)(
        'revokes the sender\'s publish after its first publication was confirmed, so the next one settles rejected no-publish-grant over %s',
        (carrier) => {
            const { sender, receiver } = toGrantedRtcScenarioOver('granted-rtc-revoked-publisher', carrier);
            const revoke = toRequests(receiver).find(({ request }) => request.path?.includes('/publication-grants/principal-alice/revoke/'));
            const refusal = toFlatCommands(sender).filter((command) => command.kind === 'assert' && command.source.includes('-publication-2-observe.value.'));

            expect(revoke?.request.body).toEqual({ topicId: GRANTED_TOPIC_ID, publish: true, subscribe: false });
            expect(toStepIndex(receiver, '-received-publication-1')).toBeLessThan(toStepIndex(receiver, '-revoke-sender-p'));
            expect(toStepIndex(receiver, '-revoke-sender-p')).toBeLessThan(toStepIndex(receiver, '-cue-revoked'));
            expect(toReceiptCounts(sender)).toEqual({ expected: 1, confirmed: 1, outsideAudience: 0 });
            expect(toStepIndex(sender, '-cue-revoked-received')).toBeLessThan(toStepIndex(sender, '-publication-2-send'));
            expect(toObservedStates(sender)).toEqual([['acknowledged'], ['rejected']]);
            expect(refusal).toEqual([
                expect.objectContaining({ source: expect.stringMatching(/\.failure\.reason$/), expected: 'no-publish-grant' })
            ]);
            expect(toPublicationAbsences(receiver)).toEqual(['publication-2']);
        }
    );

    it('reshapes the room into a path before the sender publishes, and proves the publisher-only member never delivers', () => {
        const { sender, receiver, recipientB } = toGrantedRtcScenario('granted-rtc-relay-only');
        const topology = toRequests(receiver).filter(({ request }) => request.path?.includes('/topology/config/requests/'));
        const recipientBGrants = toRequests(receiver).filter(({ request }) => request.path?.includes('/publication-grants/principal-charlie/'));

        expect(topology.map(({ request }) => [request.method, request.body])).toEqual([
            ['PUT', { config: { topologyKind: 'tree', degreeLimit: 2, meshParamK: 2 } }],
            ['DELETE', undefined]
        ]);
        expect(toStepIndex(receiver, '-topology-tree')).toBeLessThan(toStepIndex(receiver, '-grant-receiver-s-request'));
        // A cue reaches only a role that already listens, so the owner cues the path once the sender said it listens.
        expect(toStepIndex(sender, '-cue-ready-sent')).toBeLessThan(toStepIndex(sender, '-cue-tree-received'));
        expect(toStepIndex(receiver, '-cue-ready-received')).toBeLessThan(toStepIndex(receiver, '-cue-tree'));
        expect(toStepIndex(receiver, '-cue-recorded-received')).toBeLessThan(toStepIndex(receiver, '-topology-reset'));
        expect(recipientBGrants.map(({ request }) => request.body)).toEqual([
            { topicId: GRANTED_TOPIC_ID, publish: true, subscribe: false }
        ]);
        expect(toFlatCommands(sender).find((command) => command.kind === 'rtc.connect'))
            .toMatchObject({ readiness: { minReadyPeers: 1 } });
        expect(toStepIndex(sender, '-cue-tree-received')).toBeLessThan(toStepIndex(sender, '-publish'));
        expect(toFlatCommands(receiver).some((command) => command.kind === 'wait' && command.match.payloadFields?.['data.transport'] === 'rtc')).toBe(true);
        expect(toOutcomeWaits(recipientB)).toEqual([
            `"typeId":"alm.conformance.rtc.granted-rtc-relay-only","carrier":"rtc","outcome":"committed","reason":"admitted"`
        ]);
        expect(toPublicationAbsences(recipientB)).toEqual(['publication']);
        expect(toFlatCommands(recipientB).map((command) => command.kind)).not.toContain('messages.subscribe');
        for (const recipe of [sender, receiver, recipientB]) {
            expect(toFlatCommands(recipe).filter((command) => command.kind === 'health'), recipe?.recipeId)
                .toEqual([expect.objectContaining({ commandId: `${recipe!.recipeId}-overlay-next-hops` })]);
        }
    });

    it('publishes a minted receipted track over the path and holds p2 until its repair was dispatched, then releases it', () => {
        const { sender } = toGrantedRtcScenario('granted-rtc-ordered-relay');
        const prefix = 'alm-rtc-granted-rtc-ordered-relay-sender';
        const sends = toFlatCommands(sender).flatMap((command) =>
            command.kind === 'messages.send' && !('replayOnCarrier' in command) && command.commandId?.startsWith(`${prefix}-send-`) === true
                ? [command]
                : []
        );

        expect(sends.map(({ commandId, topicId, payload, orderingKey, ack, reliability }) => ({ commandId, topicId, payload, orderingKey, ack, reliability })))
            .toEqual([1, 2, 3].map((index) => ({
                commandId: `${prefix}-send-${index}`,
                topicId: GRANTED_TOPIC_ID,
                payload: { marker: 'granted-rtc-ordered-relay', carrier: 'rtc', publication: `p${index}` },
                orderingKey: 'granted-rtc-ordered-relay',
                ack: 'all-logical-recipients',
                reliability: 'at-least-once'
            })));
        expect(sends.some((send) => 'seq' in send)).toBe(false);
        // The readiness probe rides no track and expects the receiver alone: recipient-b and the sender hold no subscribe.
        expect(toReceiptCounts(sender)).toEqual({ expected: 1, confirmed: 1, outsideAudience: 0 });
        const order = [
            '-cue-tree-received',
            '-probe-ready',
            '-send-1',
            '-assert-sent-1',
            '-hold-rtc',
            '-send-2',
            '-hold-message-2-rtc',
            '-release-rtc',
            '-send-3',
            '-repair-dispatch-2',
            '-release-message-2-rtc',
            '-cue-received-received',
            '-overlay-next-hops'
        ].map((suffix) => toStepIndex(sender, suffix));
        expect(order).toEqual(order.toSorted((left, right) => left - right));
        expect(toFlatCommands(sender).find(({ commandId }) => commandId === `${prefix}-repair-dispatch-2`)).toMatchObject({
            match: {
                topic: 'rallar.browser.alm.outbound_diagnostics',
                contains: `"msgId":"{resultCache.${prefix}-send-2.value.msgId}","typeId":"alm.conformance.rtc.granted-rtc-ordered-relay",` +
                    '"origin":"repair"'
            }
        });
        expect(toFlatCommands(sender).find(({ commandId }) => commandId === `${prefix}-release-message-2-rtc`)).toMatchObject({
            match: { msgId: `{resultCache.${prefix}-send-2.value.msgId}` },
            remaining: 0
        });
    });

    it('reads the receiver entered at p1 and never omitted on the track, over the path the relay-only cell draws', () => {
        const { sender, receiver, recipientB } = toGrantedRtcScenario('granted-rtc-ordered-relay');
        const prefix = 'alm-rtc-granted-rtc-ordered-relay-receiver';
        const track = `"trackKey":"granted-rtc-ordered-relay:{resultCache.${prefix}-received-p1.value.event.payload.senderId}:`;
        const step = (name: string) => toFlatCommands(receiver).find(({ commandId }) => commandId === `${prefix}-${name}`);

        for (const publication of ['p1', 'p2', 'p3']) {
            expect(step(`received-${publication}`), publication).toMatchObject({
                kind: 'wait',
                match: { equals: { marker: 'granted-rtc-ordered-relay', carrier: 'rtc', publication } }
            });
            expect(step(`received-${publication}`), publication).not.toHaveProperty('absent');
        }
        expect(step('entered-p1')).toMatchObject({
            match: {
                contains: track,
                payloadFields: { 'data.kind': 'ordering-position', 'data.status': 'entered', 'data.priorSeq': 0 }
            }
        });
        expect(step('entered-p1')).not.toHaveProperty('absent');
        // Any prior: an omission of the held p2 would name whatever prior the sender recorded.
        expect(step('no-omitted')).toMatchObject({
            absent: true,
            match: { contains: track, payloadFields: { 'data.kind': 'ordering-position', 'data.status': 'omitted' } }
        });
        expect(step('no-omitted')).not.toHaveProperty(['match', 'payloadFields', 'data.priorSeq']);
        expect(toStepIndex(receiver, '-received-p3')).toBeLessThan(toStepIndex(receiver, '-cue-received'));
        expect(
            toRequests(receiver).filter(({ request }) => request.path?.includes('/topology/config/requests/'))
                .map(({ request }) => [request.method, request.body])
        ).toEqual([
            ['PUT', { config: { topologyKind: 'tree', degreeLimit: 2, meshParamK: 2 } }],
            ['DELETE', undefined]
        ]);
        expect(
            toRequests(receiver).filter(({ request }) => request.path?.includes('/publication-grants/principal-charlie/'))
                .map(({ request }) => request.body)
        ).toEqual([{ topicId: GRANTED_TOPIC_ID, publish: true, subscribe: false }]);
        expect(toPublicationAbsences(recipientB)).toEqual(['p1', 'p2', 'p3']);
        expect(toFlatCommands(recipientB).map((command) => command.kind)).not.toContain('messages.subscribe');
        for (const recipe of [sender, receiver, recipientB]) {
            expect(toFlatCommands(recipe).filter((command) => command.kind === 'health'), recipe?.recipeId)
                .toEqual([expect.objectContaining({ commandId: `${recipe!.recipeId}-overlay-next-hops` })]);
        }
    });
});
