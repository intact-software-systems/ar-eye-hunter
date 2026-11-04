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
import type { AlmConformanceIdentityParticipant } from '@shared-test/rallar-bb-test/conformance/alm/identity/assess-alm-conformance-identity.ts';
import { resolveAlmConformancePrincipals } from '@shared-test/rallar-bb-test/conformance/alm/resolve-alm-conformance-principals.ts';
import { assessSubscriptionRevokeDisconnected } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/topic-subscription/assess-subscription-revoke-disconnected.ts';
import { toSubscriptionSuccessorGateCommandId } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/topic-subscription/subscription-successor.ts';
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
    'subscription-revoke-disconnected',
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
/** A role's run as the control snapshot records it: every authored command ok, with the given values. */
function toRecipeRunParticipant(
    role: string,
    recipe: RallarBlackBoxTestRecipe,
    values: Readonly<Record<string, RallarBlackBoxTestJsonValue>>
): AlmConformanceIdentityParticipant {
    const commandId = `${recipe.recipeId}-run`;
    const agentId = `agent-${role}`;
    const timing = { startedAtEpochMs: 1, endedAtEpochMs: 2, durationMs: 1 };
    const results = recipe.commands.map((command) => ({
        commandId: command.commandId!,
        kind: command.kind,
        ok: true,
        status: 'ok' as const,
        ...timing,
        ...(command.commandId! in values ? { value: values[command.commandId!] } : {})
    }));
    return {
        role,
        agentId,
        commandId,
        recipe,
        result: {
            kind: 'result',
            protocolVersion: 1,
            runId: 'run',
            agentId,
            commandId,
            ok: true,
            result: { commandId, kind: 'recipe.run', ok: true, status: 'ok', ...timing, value: { recipeId: recipe.recipeId, results } }
        }
    };
}

describe('ALM topic subscription conformance', () => {
    it('the four-role family declares sender, publisher-b, receiver and sibling and runs on every carrier', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarios = toTopicSubscriptionScenarios(carrier);
            const fourRole = scenarios.filter(({ laneFamily }) => laneFamily === 'four-role');

            expect(fourRole.map(({ scenarioId }) => scenarioId), carrier).toEqual(FOUR_ROLE_IDS);
            for (const scenario of fourRole) {
                expect(scenario.roles).toEqual(['sender', 'publisher-b', 'receiver', 'sibling']);
                expect(scenario.tags).toEqual(['full']);
                expect(scenario.publisherB?.recipeId).toBe(`alm-${carrier}-${scenario.scenarioKey}-publisher-b`);
                expect(toAlmConformanceRoleRecipe(scenario, 'publisher-b')).toBe(scenario.publisherB);
            }
            expect(scenarios.filter(({ laneFamily }) => laneFamily === 'same-context').map(({ roles }) => roles))
                .toEqual([['sender', 'receiver', 'successor']]);
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

    it('creates no cell whose principals the caller does not resolve, and an unresolved placeholder throws', () => {
        const { sender: _sender, ...withoutSender } = CONFORMANCE_PRINCIPAL_IDS;
        const delivery = toTopicSubscriptionScenarios('ws').find(({ scenarioId }) => scenarioId === 'subscription-delivery')!;

        expect(
            createAlmConformanceRecipes({ ...toConformanceInput('ws'), principalIdsByRole: withoutSender })
                .some(({ scenarioId }) => scenarioId.startsWith('subscription-'))
        ).toBe(false);
        expect(() =>
            resolveAlmConformancePrincipals(
                { ...delivery.receiver, commands: [{ kind: 'assert', source: '{principal:sender}', operator: 'exists', expected: true }] },
                withoutSender
            )
        ).toThrow('alm-ws-subscription-delivery-receiver names {principal:sender}, which principalIdsByRole does not resolve.');
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

    it.each(
        [
            { carrier: 'ws', outsideAudience: 0 },
            { carrier: 'rtc', outsideAudience: 1 },
            { carrier: 'rtc-with-ws-fallback', outsideAudience: 1 }
        ] as const
    )(
        'ends a publish loop over $carrier only when the receipt expected the awaited recipients and $outsideAudience outside, all others confirming, then cues it',
        ({ carrier, outsideAudience }) => {
            const [delivery] = toTopicSubscriptionScenarios(carrier);
            for (const [producer, name] of [[delivery?.sender, 'publication-a'], [delivery?.publisherB, 'publication-c']] as const) {
                const commands = producer?.commands ?? [];
                const loop = commands.find(({ commandId }) => commandId === `${producer?.recipeId}-${name}`);
                const facts = (loop?.kind === 'loop' ? loop.commands : []).flatMap((command) =>
                    command.kind === 'assert' ? [{ source: command.source.split('.').at(-1), expected: command.expected }] : []
                );

                // The other producer holds `subscribe` without an election: over RTC it is frozen in and ends outside.
                expect(facts, producer?.recipeId).toEqual([
                    { source: 'expectedRecipientPeerIds', expected: 2 + outsideAudience },
                    { source: 'confirmedRecipientPeerIds', expected: 2 },
                    { source: 'outsideAudienceRecipientPeerIds', expected: outsideAudience }
                ]);
                expect(commands.slice(commands.indexOf(loop!) + 1).map(({ commandId }) => commandId).slice(0, 2)).toEqual([
                    `${producer?.recipeId}-cue-${name}-confirmed`,
                    `${producer?.recipeId}-cue-${name}-confirmed-sent`
                ]);
            }
        }
    );

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

    it('sends nothing from the dropped sibling once its socket closed, in the revoke-disconnected and reconnect cells', () => {
        for (const scenarioId of ['subscription-revoke-disconnected', 'subscription-reconnect']) {
            const scenario = toTopicSubscriptionScenarios('ws').find((candidate) => candidate.scenarioId === scenarioId);
            const commands = toFlatCommands(scenario?.sibling?.commands ?? []);
            const close = commands.findIndex((command) => command.kind === 'fault.inject');

            expect(close, scenarioId).toBeGreaterThan(0);
            expect(commands.slice(close).filter(({ kind }) => kind === 'messages.send'), scenarioId).toEqual([]);
        }
    });

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'expects the reconnected sibling to keep an active token and miss the publication its closed presence excludes over %s',
        (carrier) => {
            const reconnect = toTopicSubscriptionScenarios(carrier).find(({ scenarioId }) => scenarioId === 'subscription-reconnect');
            const sibling = reconnect?.sibling?.commands ?? [];
            const sender = reconnect?.sender.commands ?? [];
            const loopFacts = (name: string) => {
                const loop = sender.find(({ commandId }) => commandId === `alm-${carrier}-subscription-reconnect-sender-${name}`);
                return loop?.kind === 'loop' ? loop.commands.filter(({ kind }) => kind === 'assert') : [];
            };
            const index = (name: string) => sender.findIndex(({ commandId }) => commandId === `alm-${carrier}-subscription-reconnect-sender-${name}`);

            expect(sibling.find(({ commandId }) => commandId?.endsWith('-assert-tokens-after-rows-active'))).toMatchObject({
                operator: 'equals',
                expected: 'active'
            });
            expect(sibling.find(({ commandId }) => commandId?.endsWith('-absent-publication'))).toMatchObject({
                absent: true
            });
            // An RTC sender freezes the sibling in until its snapshot drops the closed presence, so a probe goes first.
            for (const name of ['probe-receiver-alone', 'publication']) {
                expect(loopFacts(name), name).toMatchObject([{ expected: 1 }, { expected: 1 }, { expected: 0 }]);
            }
            expect(index('probe-two-subscribers')).toBeLessThan(index('probe-receiver-alone'));
            expect(index('probe-receiver-alone')).toBeLessThan(index('publication'));
        }
    );

    it('keeps the successor\'s election, which the replaced owner page\'s later row reads name', () => {
        const successor = toTopicSubscriptionScenarios('ws').find(({ laneFamily }) => laneFamily === 'same-context');

        expect(toFlatCommands(successor?.successor?.commands ?? []).filter(({ kind }) => kind === 'messages.unsubscribe'))
            .toEqual([]);
    });

    it('pins the revoke-disconnected sibling to nothing received and a refused re-assertion, and the receiver to both', () => {
        const scenario = toTopicSubscriptionScenarios('ws').find(({ scenarioId }) => scenarioId === 'subscription-revoke-disconnected');
        const sibling = toFlatCommands(scenario?.sibling?.commands ?? []);
        const receiver = scenario?.receiver.commands ?? [];
        const publicationWaits = (commands: readonly RallarBlackBoxTestCommand[]) =>
            commands.flatMap((command) => command.kind === 'wait' && command.commandId?.includes('-publication-') ? [command.absent === true] : []);

        expect(publicationWaits(sibling)).toEqual([true, true]);
        expect(publicationWaits(receiver)).toEqual([false, false]);
        expect(sibling.find(({ commandId }) => commandId?.endsWith('-assert-reasserted-refused'))).toMatchObject({
            operator: 'equals',
            expected: 'refused'
        });
    });

    it('fails a revoke-disconnected receipt that confirms the sibling', () => {
        const scenario = toTopicSubscriptionScenarios('ws').find(({ scenarioId }) => scenarioId === 'subscription-revoke-disconnected');
        if (scenario?.sibling === undefined) {
            throw new Error('The ws carrier creates the subscription-revoke-disconnected cell.');
        }
        const siblingConnect = scenario.sibling.commands.find(({ kind }) => kind === 'rtc.connect')!.commandId!;
        const sibling = toRecipeRunParticipant('sibling', scenario.sibling, { [siblingConnect]: { sessionId: 'sibling-session' } });
        const toSender = (first: readonly string[], second: readonly string[]) =>
            toRecipeRunParticipant('sender', scenario.sender, {
                'alm-ws-subscription-revoke-disconnected-sender-publication-1-receipts': { confirmedRecipientPeerIds: first },
                'alm-ws-subscription-revoke-disconnected-sender-publication-2-receipts': { confirmedRecipientPeerIds: second }
            });

        expect(assessSubscriptionRevokeDisconnected({
            runId: 'run',
            sender: toSender(['receiver-session'], ['receiver-session']),
            sibling
        })).toEqual([]);
        expect(assessSubscriptionRevokeDisconnected({
            runId: 'run',
            sender: toSender(['receiver-session'], ['receiver-session', 'sibling-session']),
            sibling
        })).toEqual([
            'alm-ws-subscription-revoke-disconnected-sender-publication-2-send: the receipt confirms the sibling, whose ' +
            'election was revoked while it was disconnected.'
        ]);
        expect(assessSubscriptionRevokeDisconnected({
            runId: 'run',
            sender: { ...toSender([], []), result: undefined },
            sibling
        })).toEqual(['sender: missing, mismatched or failed recipe envelope.']);
    });
});
