import {
    describe,
    expect,
    it
} from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    toAlmConformanceRoleRecipe,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { assessSubscriptionRevokeHeld } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/topic-subscription/assess-subscription-revoke-held.ts';
import { toSubscriptionSuccessorGateCommandId } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/topic-subscription/subscription-successor.ts';
import type { ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestHttpRequestCommand,
    RallarBlackBoxTestJsonValue,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { CONFORMANCE_PRINCIPAL_IDS, toConformanceInput } from './alm-conformance-test-input.ts';

const FOUR_ROLE_IDS = [
    'subscription-delivery',
    'subscription-token-count',
    'subscription-revoke-held',
    'subscription-reconnect'
] as const;

const GRANTED_TOPIC_ID = 'room.alm-conformance-granted';

/** The api-v1 mutation route's own rule for a `requests/{requestId}` path segment. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

function toTopicSubscriptionScenarios(carrier: (typeof ALM_CONFORMANCE_CARRIERS)[number]): readonly AlmConformanceScenario[] {
    return createAlmConformanceRecipes(toConformanceInput(carrier))
        .filter(({ scenarioId }) => scenarioId.startsWith('subscription-'));
}

function toRoleRecipes(scenario: AlmConformanceScenario): readonly RallarBlackBoxTestRecipe[] {
    return scenario.roles.flatMap((role) => toAlmConformanceRoleRecipe(scenario, role) ?? []);
}

/** Every command a recipe runs, the children of each poll included. */
function toFlatCommands(commands: readonly RallarBlackBoxTestCommand[]): readonly RallarBlackBoxTestCommand[] {
    return commands.flatMap((command) => command.kind === 'loop' ? [command, ...toFlatCommands(command.commands)] : [command]);
}

function toGrantRequests(
    recipe: RallarBlackBoxTestRecipe
): readonly Pick<RallarBlackBoxTestHttpRequestCommand['request'], 'path' | 'body'>[] {
    return toFlatCommands(recipe.commands).flatMap((command) =>
        command.kind === 'http.request' && command.request.path?.includes('/publication-grants/')
            ? [{ path: command.request.path, body: command.request.body }]
            : []
    );
}

/** A request id as the page resolves it: a 13-character runtime identity and a poll's first attempt. */
function toResolvedRequestIds(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    return toFlatCommands(recipe.commands).flatMap((command) => {
        const path = command.kind === 'http.request' ? command.request.path : undefined;
        const requestId = path?.split('/requests/')[1];
        return requestId === undefined
            ? []
            : [requestId.replace('{runtimeIdentity}', 'k3x9q2m7v1z0p').replace('{loop.iteration}', '1')];
    });
}

/** A role's recipe run as the control run records it: every command ok, with the values the cell reads. */
function toRecipeRunEnvelope(
    recipe: RallarBlackBoxTestRecipe,
    values: Readonly<Record<string, RallarBlackBoxTestJsonValue | undefined>>
): ControlResultEnvelope {
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: 'run',
        agentId: recipe.recipeId,
        commandId: `${recipe.recipeId}-run`,
        ok: true,
        result: {
            commandId: `${recipe.recipeId}-run`,
            kind: 'recipe.run',
            ok: true,
            status: 'ok',
            startedAtEpochMs: 1,
            endedAtEpochMs: 3,
            durationMs: 2,
            value: {
                recipeId: recipe.recipeId,
                results: Object.entries(values).map(([commandId, value]) => ({
                    commandId,
                    kind: 'messages.receipts',
                    ok: true,
                    status: 'ok',
                    startedAtEpochMs: 1,
                    endedAtEpochMs: 2,
                    durationMs: 1,
                    value
                }))
            }
        }
    };
}

describe('ALM topic subscription conformance', () => {
    it('the four-role family declares sender, publisher-b, receiver and sibling and runs over ws and rtc-with-ws-fallback only', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarios = toTopicSubscriptionScenarios(carrier);
            const fourRole = scenarios.filter(({ laneFamily }) => laneFamily === 'four-role');

            expect(fourRole.map(({ scenarioId }) => scenarioId), carrier).toEqual(carrier === 'rtc' ? [] : FOUR_ROLE_IDS);
            for (const scenario of fourRole) {
                expect(scenario.roles).toEqual(['sender', 'publisher-b', 'receiver', 'sibling']);
                expect(scenario.tags).toEqual(['full']);
                expect(scenario.publisherB?.recipeId).toBe(`alm-${carrier}-${scenario.scenarioKey}-publisher-b`);
                expect(toAlmConformanceRoleRecipe(scenario, 'publisher-b')).toBe(scenario.publisherB);
            }
            expect(scenarios.filter(({ laneFamily }) => laneFamily === 'same-context').map(({ roles }) => roles))
                .toEqual(carrier === 'rtc' ? [] : [['sender', 'receiver', 'successor']]);
        }
    });

    it('connects every role on the granted topic and opens its channel there as granted', () => {
        for (const scenario of toTopicSubscriptionScenarios('ws')) {
            for (const recipe of toRoleRecipes(scenario)) {
                const connect = recipe.commands.find((command) => command.kind === 'rtc.connect');
                expect(connect?.kind === 'rtc.connect' ? connect.rallar : undefined, recipe.recipeId).toMatchObject({
                    topicId: GRANTED_TOPIC_ID,
                    messageSelector: { topicId: GRANTED_TOPIC_ID, access: 'granted' }
                });
                expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe), recipe.recipeId)
                    .toMatchObject({ ok: true });
            }
        }
    });

    it('owner grants resolve the principal placeholders from principalIdsByRole', () => {
        const [delivery] = toTopicSubscriptionScenarios('ws');
        if (delivery === undefined) {
            throw new Error('The ws carrier creates the subscription-delivery cell.');
        }

        expect(toGrantRequests(delivery.receiver)).toEqual([
            {
                path: expect.stringContaining(`/publication-grants/${CONFORMANCE_PRINCIPAL_IDS.receiver}/grant/requests/`),
                body: { topicId: GRANTED_TOPIC_ID, publish: false, subscribe: true }
            },
            {
                path: expect.stringContaining(`/publication-grants/${CONFORMANCE_PRINCIPAL_IDS['publisher-b']}/grant/`),
                body: { topicId: GRANTED_TOPIC_ID, publish: true, subscribe: true }
            },
            {
                path: expect.stringContaining(`/publication-grants/${CONFORMANCE_PRINCIPAL_IDS.sender}/grant/`),
                body: { topicId: GRANTED_TOPIC_ID, publish: true, subscribe: true }
            }
        ]);
        expect(JSON.stringify(delivery.receiver)).not.toContain('{principal:');
    });

    it('an unresolved principal placeholder throws at creation', () => {
        const { sender: _sender, ...withoutSender } = CONFORMANCE_PRINCIPAL_IDS;

        expect(() => createAlmConformanceRecipes({ ...toConformanceInput('ws'), principalIdsByRole: withoutSender }))
            .toThrow('alm-ws-subscription-delivery-receiver names {principal:sender}, which principalIdsByRole does not resolve.');
        expect(
            createAlmConformanceRecipes({
                ...toConformanceInput('ws'),
                laneFamilies: ['two-agent', 'addressed', 'three-agent'],
                principalIdsByRole: {}
            }).some(({ scenarioId }) => scenarioId.startsWith('subscription-'))
        ).toBe(false);
    });

    it('every topic-subscription requestId is at least 20 characters', () => {
        for (const carrier of ['ws', 'rtc-with-ws-fallback'] as const) {
            const requestIds = toTopicSubscriptionScenarios(carrier).flatMap(toRoleRecipes).flatMap(toResolvedRequestIds);

            expect(requestIds.length, carrier).toBeGreaterThan(0);
            for (const requestId of requestIds) {
                expect(requestId, requestId).toMatch(REQUEST_ID_PATTERN);
            }
        }
    });

    it('publisher-b recipes carry the sender commands', () => {
        const [delivery] = toTopicSubscriptionScenarios('ws');
        const sends = (recipe: RallarBlackBoxTestRecipe | undefined) =>
            toFlatCommands(recipe?.commands ?? []).flatMap((command) =>
                command.kind === 'messages.send' && !('replayOnCarrier' in command) && command.topicId === GRANTED_TOPIC_ID
                    ? [command.payload]
                    : []
            );

        expect(sends(delivery?.sender)).toEqual([
            { marker: 'subscription-delivery', carrier: 'ws', publication: 'publication-a' }
        ]);
        expect(sends(delivery?.publisherB)).toEqual([
            { marker: 'subscription-delivery', carrier: 'ws', publication: 'publication-c' }
        ]);
    });

    it('opens the successor once the owner page read its own generation', () => {
        const successor = toTopicSubscriptionScenarios('ws').find(({ laneFamily }) => laneFamily === 'same-context');
        if (successor === undefined) {
            throw new Error('The ws carrier creates the subscription-successor cell.');
        }
        const gate = toSubscriptionSuccessorGateCommandId(successor.sender);
        const ownerCommands = successor.sender.commands.map(({ kind, commandId }) => ({ kind, commandId }));

        expect(gate).toBe('alm-ws-subscription-successor-sender-tokens-owner-generation');
        expect(ownerCommands.findIndex(({ commandId }) => commandId === gate))
            .toBe(ownerCommands.findIndex(({ kind }) => kind === 'loop') + 1);
    });

    it('polls the reconnected sibling\'s rows until its one row names the reopened socket\'s generation', () => {
        const reconnect = toTopicSubscriptionScenarios('ws').find(({ scenarioId }) => scenarioId === 'subscription-reconnect');
        const poll = reconnect?.sibling?.commands.find(({ commandId }) => commandId === 'alm-ws-subscription-reconnect-sibling-rows-reconnected');
        const children = poll?.kind === 'loop' ? poll.commands : [];

        expect(children.map(({ kind }) => kind)).toEqual(['http.request', 'assert', 'wait']);
        expect(children[2]).toMatchObject({
            match: {
                topic: 'rallar.bb.http.response',
                contains: '"connectionGenerationId":"{resultCache.alm-ws-subscription-reconnect-sibling-tokens-reconnected.value.connectionGenerationId}"'
            }
        });
        expect(children[2]).not.toHaveProperty('absent');
    });

    it('ends a publish loop only when the server expected exactly the awaited recipients and all confirmed, then cues it', () => {
        const [delivery] = toTopicSubscriptionScenarios('ws');
        const commands = delivery?.sender.commands ?? [];
        const loop = commands.find(({ commandId }) => commandId === 'alm-ws-subscription-delivery-sender-publication-a');
        const facts = (loop?.kind === 'loop' ? loop.commands : []).flatMap((command) =>
            command.kind === 'assert' ? [{ source: command.source.split('.').at(-1), expected: command.expected }] : []
        );

        expect(facts).toEqual([
            { source: 'expectedRecipientPeerIds', expected: 2 },
            { source: 'confirmedRecipientPeerIds', expected: 2 }
        ]);
        expect(commands.slice(commands.indexOf(loop!) + 1).map(({ commandId }) => commandId).slice(0, 2)).toEqual([
            'alm-ws-subscription-delivery-sender-cue-publication-a-confirmed',
            'alm-ws-subscription-delivery-sender-cue-publication-a-confirmed-sent'
        ]);
    });

    it('holds every delivery subscriber\'s election until both producers cued their confirmed copy', () => {
        const [delivery] = toTopicSubscriptionScenarios('ws');
        for (const recipe of [delivery?.receiver, delivery?.sibling]) {
            const ids = (recipe?.commands ?? []).map(({ commandId }) => commandId ?? '');
            const firstRelease = ids.findIndex((id) => id.includes('-unsubscribe-'));
            const cueWaits = ids.flatMap((id, index) => id.endsWith('-confirmed-received') ? [index] : []);

            expect(cueWaits, recipe?.recipeId).toHaveLength(2);
            expect(Math.max(...cueWaits), recipe?.recipeId).toBeLessThan(firstRelease);
        }
    });

    it('sends nothing from the dropped sibling once its socket closed, in the revoke-held and reconnect cells', () => {
        for (const scenarioId of ['subscription-revoke-held', 'subscription-reconnect']) {
            const scenario = toTopicSubscriptionScenarios('ws').find((candidate) => candidate.scenarioId === scenarioId);
            const commands = toFlatCommands(scenario?.sibling?.commands ?? []);
            const close = commands.findIndex((command) => command.kind === 'fault.inject');

            expect(close, scenarioId).toBeGreaterThan(0);
            expect(commands.slice(close).filter(({ kind }) => kind === 'messages.send'), scenarioId).toEqual([]);
        }
    });

    it('expects the reconnected sibling to keep an active token and miss the publication its closed presence excludes', () => {
        const reconnect = toTopicSubscriptionScenarios('ws').find(({ scenarioId }) => scenarioId === 'subscription-reconnect');
        const sibling = reconnect?.sibling?.commands ?? [];
        const publication = reconnect?.sender.commands.find(({ commandId }) => commandId === 'alm-ws-subscription-reconnect-sender-publication');

        expect(sibling.find(({ commandId }) => commandId?.endsWith('-assert-tokens-after-rows-active'))).toMatchObject({
            operator: 'equals',
            expected: 'active'
        });
        expect(sibling.find(({ commandId }) => commandId?.endsWith('-absent-publication'))).toMatchObject({
            absent: true
        });
        expect(publication?.kind === 'loop' ? publication.commands.filter(({ kind }) => kind === 'assert') : [])
            .toMatchObject([{ expected: 1 }, { expected: 1 }]);
    });

    it('keeps the successor\'s election, which the replaced owner page\'s later row reads name', () => {
        const successor = toTopicSubscriptionScenarios('ws').find(({ laneFamily }) => laneFamily === 'same-context');

        expect(toFlatCommands(successor?.successor?.commands ?? []).filter(({ kind }) => kind === 'messages.unsubscribe'))
            .toEqual([]);
    });

    it('fails a revoke-held receipt that confirms the sibling and records whether the first expected set named it', () => {
        const scenario = toTopicSubscriptionScenarios('ws').find(({ scenarioId }) => scenarioId === 'subscription-revoke-held');
        if (scenario?.sibling === undefined) {
            throw new Error('The ws carrier creates the subscription-revoke-held cell.');
        }
        const sibling = {
            recipe: scenario.sibling,
            result: toRecipeRunEnvelope(scenario.sibling, {
                'alm-ws-subscription-revoke-held-sibling-connect': { sessionId: 'sibling-session' }
            })
        };
        const toSender = (first: RallarBlackBoxTestJsonValue | undefined, second: RallarBlackBoxTestJsonValue | undefined) => ({
            recipe: scenario.sender,
            result: toRecipeRunEnvelope(scenario.sender, {
                'alm-ws-subscription-revoke-held-sender-publication-1-receipts': first,
                'alm-ws-subscription-revoke-held-sender-publication-2-receipts': second
            })
        });
        const receipt = (expected: readonly string[], confirmed: readonly string[]) => ({
            expectedRecipientPeerIds: expected,
            confirmedRecipientPeerIds: confirmed
        });

        expect(assessSubscriptionRevokeHeld({
            sender: toSender(receipt(['receiver-session', 'sibling-session'], ['receiver-session']), receipt(['receiver-session'], ['receiver-session'])),
            sibling
        })).toEqual({ issues: [], siblingExpectedFirst: true });
        expect(assessSubscriptionRevokeHeld({
            sender: toSender(receipt(['receiver-session'], ['receiver-session']), receipt(['receiver-session', 'sibling-session'], ['sibling-session'])),
            sibling
        })).toEqual({
            issues: [
                'alm-ws-subscription-revoke-held-sender-publication-2-send: the receipt confirms the sibling, whose ' +
                'election was revoked before it reopened.'
            ],
            siblingExpectedFirst: false
        });
        expect(assessSubscriptionRevokeHeld({ sender: toSender(undefined, undefined), sibling }).siblingExpectedFirst)
            .toBeUndefined();
    });
});
