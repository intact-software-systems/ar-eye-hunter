import { readFileSync } from 'node:fs';

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
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestHttpRequestCommand,
    RallarBlackBoxTestJsonValue,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    createDefaultRallarBlackBoxTestRuntime
} from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { CONFORMANCE_PRINCIPAL_IDS, toConformanceInput } from './alm-conformance-test-input.ts';
import { describeDeclaredStartStates, PERMISSIONS, type DeclaredState, type StartStateTable } from './describe-declared-start-states.ts';
import { writeAlmCellStartEvents } from './write-alm-cell-start-events.ts';

const FOUR_ROLE_IDS = [
    'subscription-delivery',
    'subscription-token-count',
    'subscription-revoke-disconnected',
    'subscription-ordered-entry',
    'subscription-ordered-omission',
    'subscription-ordered-reconnect'
] as const;

const GRANTED_TOPIC_ID = 'room.alm-conformance-granted';

const { NONE, SUBSCRIBE, BOTH } = PERMISSIONS;

/** Both producers hold both permissions and the sibling shares the sender's; only the receiver and sibling elect. */
const PRODUCERS_HOLD_BOTH: DeclaredState = { receiver: SUBSCRIBE, 'publisher-b': BOTH, sender: BOTH };

const TOPIC_SUBSCRIPTION_START_STATES: StartStateTable = {
    'subscription-delivery': PRODUCERS_HOLD_BOTH,
    'subscription-ordered-entry': PRODUCERS_HOLD_BOTH,
    'subscription-ordered-omission': PRODUCERS_HOLD_BOTH,
    'subscription-ordered-reconnect': PRODUCERS_HOLD_BOTH,
    // The sender's grant is the cell's subject: it follows the receiver's release of its first token.
    'subscription-token-count': { receiver: SUBSCRIBE, 'publisher-b': NONE, sender: NONE },
    'subscription-revoke-disconnected': { receiver: SUBSCRIBE, 'publisher-b': NONE, sender: BOTH },
    'subscription-successor': { receiver: PERMISSIONS.PUBLISH, sender: SUBSCRIBE }
};

describeDeclaredStartStates('subscription-', TOPIC_SUBSCRIPTION_START_STATES);

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
                .toEqual(carrier === 'ws' ? [['sender', 'receiver', 'successor']] : []);
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

        const grantee = (principalId: string | undefined, operation: string, body: { publish: boolean; subscribe: boolean; }) => ({
            path: expect.stringContaining(`/publication-grants/${principalId}/${operation}/requests/`),
            body: { topicId: GRANTED_TOPIC_ID, ...body }
        });
        // Per principal: a revoke of its rows and of what it does not hold, then a grant of what it holds.
        expect(toGrantRequests(delivery.receiver)).toEqual([
            grantee(CONFORMANCE_PRINCIPAL_IDS.receiver, 'revoke', { publish: true, subscribe: true }),
            grantee(CONFORMANCE_PRINCIPAL_IDS.receiver, 'grant', { publish: false, subscribe: true }),
            grantee(CONFORMANCE_PRINCIPAL_IDS['publisher-b'], 'revoke', { publish: false, subscribe: true }),
            grantee(CONFORMANCE_PRINCIPAL_IDS['publisher-b'], 'grant', { publish: true, subscribe: true }),
            grantee(CONFORMANCE_PRINCIPAL_IDS.sender, 'revoke', { publish: false, subscribe: true }),
            grantee(CONFORMANCE_PRINCIPAL_IDS.sender, 'grant', { publish: true, subscribe: true })
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
        const gate = successor.successorGate;
        const ownerCommands = successor.sender.commands.map(({ kind, commandId }) => ({ kind, commandId }));

        expect(gate).toEqual({ role: 'sender', commandId: 'alm-ws-subscription-successor-sender-tokens-owner-generation' });
        expect(ownerCommands.findIndex(({ commandId }) => commandId === gate?.commandId))
            .toBe(ownerCommands.findIndex(({ kind }) => kind === 'loop') + 1);
    });

    it.each(
        [
            { carrier: 'ws', outsideAudience: 0 },
            { carrier: 'rtc', outsideAudience: 1 },
            { carrier: 'rtc-with-ws-fallback', outsideAudience: 1 }
        ] as const
    )(
        'ends a publish loop over $carrier once the receipt expects the awaited recipients and $outsideAudience outside, the rest confirming',
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

/** The receiver's start state of the producers' cells: each principal's rows and unheld permissions revoked, then granted. */
const START_STATE_STEPS = [
    'start-revoke-receiver-ps',
    'start-grant-receiver-s',
    'start-revoke-publisher-b-s',
    'start-grant-publisher-b-ps',
    'start-revoke-sender-s',
    'start-grant-sender-ps'
] as const;

type OrderedScenarioId = 'subscription-ordered-entry' | 'subscription-ordered-omission' | 'subscription-ordered-reconnect';
type ProducerRole = 'sender' | 'publisher-b';

/** Each producer's own track: `a` names the sender's publications, `c` publisher-b's. */
const PRODUCER_TRACKS: readonly (readonly [ProducerRole, 'a' | 'c'])[] = [['sender', 'a'], ['publisher-b', 'c']];

function findOrderedScenario(
    carrier: (typeof ALM_CONFORMANCE_CARRIERS)[number],
    scenarioId: OrderedScenarioId
): AlmConformanceScenario {
    const scenario = toTopicSubscriptionScenarios(carrier).find((candidate) => candidate.scenarioId === scenarioId);
    if (scenario === undefined) {
        throw new Error(`${carrier} creates no ${scenarioId} cell.`);
    }
    return scenario;
}

function requireRoleRecipe(scenario: AlmConformanceScenario, role: ProducerRole | 'receiver' | 'sibling'): RallarBlackBoxTestRecipe {
    const recipe = toAlmConformanceRoleRecipe(scenario, role);
    if (recipe === undefined) {
        throw new Error(`${scenario.scenarioKey} has no ${role} recipe.`);
    }
    return recipe;
}

/** The steps a role runs between its connect and its stats read, named without the recipe's prefix. */
function toStepNames(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    const prefix = `${recipe.recipeId}-`;
    const connect = recipe.commands.findIndex(({ kind }) => kind === 'rtc.connect');
    return recipe.commands.slice(connect + 1)
        .map(({ commandId }) => (commandId ?? '').replace(prefix, ''))
        .filter((name) => name !== 'storage-counters-connected' && name !== 'stats');
}

function findStep(recipe: RallarBlackBoxTestRecipe, name: string): RallarBlackBoxTestCommand {
    const command = recipe.commands.find(({ commandId }) => commandId === `${recipe.recipeId}-${name}`);
    if (command === undefined) {
        throw new Error(`${recipe.recipeId} has no ${name}.`);
    }
    return command;
}

/** The expected, confirmed and outside counts a publish loop ends on, in the order it asserts them. */
function toLoopCounts(recipe: RallarBlackBoxTestRecipe, name: string): readonly (RallarBlackBoxTestJsonValue | undefined)[] {
    const loop = findStep(recipe, name);
    return (loop.kind === 'loop' ? loop.commands : []).flatMap((command) => command.kind === 'assert' ? [command.expected] : []);
}

function toLoopSend(recipe: RallarBlackBoxTestRecipe, name: string): RallarBlackBoxTestCommand | undefined {
    const loop = findStep(recipe, name);
    return (loop.kind === 'loop' ? loop.commands : []).find(({ kind }) => kind === 'messages.send');
}

/** One publish loop, its confirmed cue and the cue's leaving. */
function toPublishSteps(name: string): readonly string[] {
    return [name, `cue-${name}-confirmed`, `cue-${name}-confirmed-sent`];
}

function toPublicationSteps(state: 'received' | 'absent', track: 'a' | 'c', publications: readonly number[]): readonly string[] {
    return publications.map((publication) => `${state}-${track}-p${publication}`);
}

function toConfirmedCueSteps(publication: number): readonly string[] {
    return PRODUCER_TRACKS.map(([, track]) => `cue-${track}-p${publication}-confirmed-received`);
}

function toCounts(confirmations: number, outsideAudience: number): readonly number[] {
    return [confirmations + outsideAudience, confirmations, outsideAudience];
}

function findBarrieredReconnectScenario(carrier: (typeof ALM_CONFORMANCE_CARRIERS)[number]): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes({ ...toConformanceInput(carrier), cellSettle: 'barriered' })
        .find(({ scenarioId }) => scenarioId === 'subscription-ordered-reconnect');
    if (scenario === undefined) {
        throw new Error(`${carrier} creates no barriered subscription-ordered-reconnect cell.`);
    }
    return scenario;
}

/** Runs one wait on a page whose history holds `events` in order; the wait gets 1 ms, the history being complete. */
async function runWaitAfterEvents(
    wait: RallarBlackBoxTestCommand,
    events: readonly Parameters<ReturnType<typeof createDefaultRallarBlackBoxTestRuntime>['recordEvent']>[0][]
): Promise<boolean> {
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    for (const event of events) {
        runtime.recordEvent(event);
    }
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'session-removal-probe',
        commands: [{ ...wait, timeoutMs: 1 }]
    };
    return (await runtime.execute({ kind: 'recipe.run', recipe })).ok;
}

/** Runs `commands` on a page whose history already holds `events`; each wait gets 1 ms, the history being complete. */
async function runAfterEvents(
    commands: readonly RallarBlackBoxTestCommand[],
    events: readonly Parameters<ReturnType<typeof createDefaultRallarBlackBoxTestRuntime>['recordEvent']>[0][]
): Promise<boolean> {
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    writeAlmCellStartEvents(runtime, commands);
    for (const event of events) {
        runtime.recordEvent(event);
    }
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'ordering-position-probe',
        commands: commands.map((command) => ({ ...command, timeoutMs: 1 }))
    };
    return (await runtime.execute({ kind: 'recipe.run', recipe })).ok;
}

describe('ALM ordered subscription entry conformance', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('names each producer\'s track by the cell and mints every ordered send over %s', (carrier) => {
        for (const scenarioId of ['subscription-ordered-entry', 'subscription-ordered-omission'] as const) {
            const scenario = findOrderedScenario(carrier, scenarioId);
            for (const [role, track] of PRODUCER_TRACKS) {
                const producer = requireRoleRecipe(scenario, role);
                const ordered = toStepNames(producer).filter((name) => name.startsWith(`${track}-p`));

                expect(ordered.length, producer.recipeId).toBeGreaterThan(0);
                for (const name of ordered) {
                    const send = toLoopSend(producer, name);
                    expect(send, `${producer.recipeId} ${name}`).toMatchObject({ orderingKey: scenarioId, ack: 'all-logical-recipients' });
                    expect(send, `${producer.recipeId} ${name}`).not.toHaveProperty('seq');
                }
                // The readiness probe rides no track, so it moves no recipient's position.
                expect(toLoopSend(producer, 'probe-ready'), producer.recipeId).not.toHaveProperty('orderingKey');
            }
        }
    });

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'subscribes the sibling over %s once the receiver relays both producers\' p2, then publishes p3',
        (carrier) => {
            const scenario = findOrderedScenario(carrier, 'subscription-ordered-entry');
            const sibling = requireRoleRecipe(scenario, 'sibling');
            const positions = carrier === 'ws'
                ? ['entered-a-p3', 'entered-c-p3']
                : ['witnessed-a-p1', 'witnessed-a-p2', 'witnessed-c-p1', 'witnessed-c-p2'];

            for (const [role, track] of PRODUCER_TRACKS) {
                expect(toStepNames(requireRoleRecipe(scenario, role)), role).toEqual([
                    'cue-listen',
                    'cue-listen-sent',
                    ...toPublishSteps('probe-ready'),
                    ...toPublishSteps(`${track}-p1`),
                    ...toPublishSteps(`${track}-p2`),
                    'cue-entered-received',
                    ...toPublishSteps(`${track}-p3`),
                    'no-repair-dispatch',
                    'no-gap-nack'
                ]);
            }
            // Publisher-b may publish both before the sibling listens, so the receiver, listening first, relays them.
            expect(toStepNames(sibling)).toEqual([
                'cue-listen',
                'cue-listen-sent',
                'cue-published-2-received',
                'subscribe-sibling',
                'subscribe-delta-margin',
                'cue-entered',
                'cue-entered-sent',
                ...toPublicationSteps('received', 'a', [3]),
                ...toPublicationSteps('received', 'c', [3]),
                ...positions,
                ...toPublicationSteps('absent', 'a', [1, 2]),
                ...toPublicationSteps('absent', 'c', [1, 2]),
                ...toConfirmedCueSteps(3),
                'unsubscribe-sibling',
                'assert-unsubscribe-sibling-lapsed'
            ]);
            expect(toStepNames(requireRoleRecipe(scenario, 'receiver'))).toEqual([
                'cue-listen',
                'cue-listen-sent',
                ...START_STATE_STEPS,
                'subscribe-receiver',
                ...toPublicationSteps('received', 'a', [1, 2]),
                ...toPublicationSteps('received', 'c', [1, 2]),
                ...toConfirmedCueSteps(2),
                'cue-published-2',
                'cue-published-2-sent',
                ...toPublicationSteps('received', 'a', [3]),
                ...toPublicationSteps('received', 'c', [3]),
                ...toConfirmedCueSteps(3),
                'unsubscribe-receiver',
                'assert-unsubscribe-receiver-lapsed'
            ]);
        }
    );

    it.each(
        [
            { carrier: 'ws', unelected: 0, frozenOut: 0 },
            { carrier: 'rtc', unelected: 1, frozenOut: 2 },
            { carrier: 'rtc-with-ws-fallback', unelected: 1, frozenOut: 2 }
        ] as const
    )(
        'counts the unelected sibling and other producer outside the first two publications over $carrier, the other producer alone after',
        ({ carrier, unelected, frozenOut }) => {
            const scenario = findOrderedScenario(carrier, 'subscription-ordered-entry');
            for (const [role, track] of PRODUCER_TRACKS) {
                const producer = requireRoleRecipe(scenario, role);

                expect(toLoopCounts(producer, 'probe-ready'), role).toEqual(toCounts(1, frozenOut));
                expect(toLoopCounts(producer, `${track}-p1`), role).toEqual(toCounts(1, frozenOut));
                expect(toLoopCounts(producer, `${track}-p2`), role).toEqual(toCounts(1, frozenOut));
                expect(toLoopCounts(producer, `${track}-p3`), role).toEqual(toCounts(2, unelected));
            }
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)('omits the sibling\'s revoked stretch over %s and re-admits it under a new election', (carrier) => {
        const scenario = findOrderedScenario(carrier, 'subscription-ordered-omission');
        const receiver = requireRoleRecipe(scenario, 'receiver');

        for (const [role, track] of PRODUCER_TRACKS) {
            expect(toStepNames(requireRoleRecipe(scenario, role)), role).toEqual([
                'cue-listen',
                'cue-listen-sent',
                ...toPublishSteps('probe-ready'),
                ...toPublishSteps(`${track}-p1`),
                ...toPublishSteps(`${track}-p2`),
                'cue-revoked-received',
                ...toPublishSteps(`${track}-p3`),
                ...toPublishSteps(`${track}-p4`),
                'cue-resubscribed-received',
                ...toPublishSteps(`${track}-p5`),
                'no-repair-dispatch',
                'no-gap-nack'
            ]);
        }
        expect(toStepNames(receiver)).toEqual([
            'cue-listen',
            'cue-listen-sent',
            ...START_STATE_STEPS,
            'subscribe-receiver',
            ...toPublicationSteps('received', 'a', [1, 2]),
            ...toPublicationSteps('received', 'c', [1, 2]),
            ...toConfirmedCueSteps(2),
            'revoke-sender-s',
            'revoke-delta-margin',
            'cue-revoked',
            'cue-revoked-sent',
            ...toPublicationSteps('received', 'a', [3, 4]),
            ...toPublicationSteps('received', 'c', [3, 4]),
            ...toConfirmedCueSteps(4),
            'grant-sender-s',
            'cue-regranted',
            'cue-regranted-sent',
            ...toPublicationSteps('received', 'a', [5]),
            ...toPublicationSteps('received', 'c', [5]),
            ...toConfirmedCueSteps(5),
            'unsubscribe-receiver',
            'assert-unsubscribe-receiver-lapsed'
        ]);
        expect(toStepNames(requireRoleRecipe(scenario, 'sibling'))).toEqual([
            'cue-listen',
            'cue-listen-sent',
            'subscribe-sibling',
            ...toPublicationSteps('received', 'a', [1, 2]),
            ...toPublicationSteps('received', 'c', [1, 2]),
            'cue-regranted-received',
            'unsubscribe-sibling',
            'assert-unsubscribe-sibling-lapsed',
            'subscribe-sibling-regranted',
            'subscribe-delta-margin',
            'cue-resubscribed',
            'cue-resubscribed-sent',
            ...toPublicationSteps('received', 'a', [5]),
            ...toPublicationSteps('received', 'c', [5]),
            'omitted-a-p5',
            'omitted-c-p5',
            ...toPublicationSteps('absent', 'a', [3, 4]),
            ...toPublicationSteps('absent', 'c', [3, 4]),
            ...toConfirmedCueSteps(5),
            'unsubscribe-sibling-regranted',
            'assert-unsubscribe-sibling-regranted-lapsed'
        ]);
        // D492: the revoke takes the sender principal's `subscribe` alone, and the re-grant gives exactly it back.
        expect(toGrantRequests(receiver).map(({ path, body }) => ({ operation: path?.split('/')[11], body })).slice(6)).toEqual([
            { operation: 'revoke', body: { topicId: GRANTED_TOPIC_ID, publish: false, subscribe: true } },
            { operation: 'grant', body: { topicId: GRANTED_TOPIC_ID, publish: false, subscribe: true } }
        ]);
        expect(findStep(receiver, 'revoke-delta-margin')).toMatchObject({ kind: 'wait', absent: true, timeoutMs: 2_000 });
    });

    it.each(
        [
            { carrier: 'ws', unelected: 0 },
            { carrier: 'rtc', unelected: 1 },
            { carrier: 'rtc-with-ws-fallback', unelected: 1 }
        ] as const
    )('counts the revoked sibling in no audience over $carrier, and publisher-b, which keeps subscribe, outside the sender\'s', ({ carrier, unelected }) => {
        const scenario = findOrderedScenario(carrier, 'subscription-ordered-omission');
        for (const [role, track] of PRODUCER_TRACKS) {
            const producer = requireRoleRecipe(scenario, role);
            const revokedOutside = role === 'sender' ? unelected : 0;

            expect(toLoopCounts(producer, 'probe-ready'), role).toEqual(toCounts(2, unelected));
            for (const publication of [1, 2, 5]) {
                expect(toLoopCounts(producer, `${track}-p${publication}`), `${role} p${publication}`).toEqual(toCounts(2, unelected));
            }
            for (const publication of [3, 4]) {
                expect(toLoopCounts(producer, `${track}-p${publication}`), `${role} p${publication}`).toEqual(toCounts(1, revokedOutside));
            }
        }
    });

    it('waits on the ordering-position event of each producer\'s track, read from the sibling\'s own arrival', () => {
        const entered = findStep(requireRoleRecipe(findOrderedScenario('ws', 'subscription-ordered-entry'), 'sibling'), 'entered-a-p3');
        const omitted = findStep(requireRoleRecipe(findOrderedScenario('rtc', 'subscription-ordered-omission'), 'sibling'), 'omitted-c-p5');
        const witnessed = findStep(requireRoleRecipe(findOrderedScenario('rtc', 'subscription-ordered-entry'), 'sibling'), 'witnessed-c-p2');

        expect(entered).toMatchObject({
            kind: 'wait',
            match: {
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.inbound_diagnostics',
                payloadPath: 'data',
                contains: '"trackKey":"subscription-ordered-entry:' +
                    '{resultCache.alm-ws-subscription-ordered-entry-sibling-received-a-p3.value.event.payload.senderId}:',
                payloadFields: { 'data.kind': 'ordering-position', 'data.status': 'entered', 'data.priorSeq': 0 }
            }
        });
        expect(entered).not.toHaveProperty('absent');
        expect(omitted).toMatchObject({
            match: {
                contains: '"trackKey":"subscription-ordered-omission:' +
                    '{resultCache.alm-rtc-subscription-ordered-omission-sibling-received-c-p5.value.event.payload.senderId}:',
                payloadFields: { 'data.kind': 'ordering-position', 'data.status': 'omitted', 'data.priorSeq': 2 }
            }
        });
        expect(witnessed).toMatchObject({
            match: { payloadFields: { 'data.kind': 'ordering-position', 'data.status': 'witnessed', 'data.priorSeq': 1 } }
        });
    });

    it('matches the emitted entry of the arrival\'s own track and nothing of the other producer\'s', async () => {
        const sibling = requireRoleRecipe(findOrderedScenario('ws', 'subscription-ordered-entry'), 'sibling');
        const steps = [findStep(sibling, 'received-a-p3'), findStep(sibling, 'entered-a-p3')];
        const arrival = {
            kind: 'message' as const,
            topic: 'rallar.browser.messages.ws.message',
            connection: 'receiver',
            payload: {
                senderId: 'peer-a',
                data: { payload: { marker: 'subscription-ordered-entry', carrier: 'ws', publication: 'a-p3' } }
            }
        };
        // The inbound admission's event, in its emitted key order.
        const toPosition = (trackKey: string, status: string) => ({
            kind: 'diagnostic' as const,
            topic: 'rallar.browser.alm.inbound_diagnostics',
            payload: {
                data: { kind: 'ordering-position', workerId: 'w', trackKey, seq: 3, priorSeq: 0, status, carrier: 'ws', traceId: 't', corrId: 'c' }
            }
        });

        expect(await runAfterEvents(steps, [arrival, toPosition('subscription-ordered-entry:peer-a:0', 'entered')])).toBe(true);
        expect(await runAfterEvents(steps, [arrival, toPosition('subscription-ordered-entry:peer-c:0', 'entered')])).toBe(false);
        expect(await runAfterEvents(steps, [arrival, toPosition('subscription-ordered-entry:peer-a:0', 'omitted')])).toBe(false);
    });

    it('listens one window for a late copy of any absent publication, the later absences reading the history alone', () => {
        const sibling = requireRoleRecipe(findOrderedScenario('ws', 'subscription-ordered-omission'), 'sibling');
        const absences = toStepNames(sibling).filter((name) => name.startsWith('absent-')).map((name) => findStep(sibling, name));

        expect(absences.map((wait) => wait.kind === 'wait' ? [wait.absent, wait.timeoutMs] : [])).toEqual([
            [true, 5_000],
            [true, 0],
            [true, 0],
            [true, 0]
        ]);
    });

    it.each(['subscription-ordered-entry', 'subscription-ordered-omission'] as const)(
        'asserts in %s that no gap NACK about the cell\'s tracks reached either producer, from the history the repair wait kept',
        (cell) => {
            const scenario = findOrderedScenario('rtc', cell);
            for (const [role] of PRODUCER_TRACKS) {
                expect(findStep(requireRoleRecipe(scenario, role), 'no-gap-nack')).toMatchObject({
                    kind: 'wait',
                    absent: true,
                    timeoutMs: 0,
                    match: {
                        kind: 'diagnostic',
                        topic: 'rallar.browser.alm.outbound_diagnostics',
                        contains: `"nackReason":"gap","nackOrderingKey":"${cell}:`
                    }
                });
            }
        }
    );

    it('asserts no repair dispatch of the cell\'s type on either producer', () => {
        const scenario = findOrderedScenario('rtc-with-ws-fallback', 'subscription-ordered-omission');
        for (const [role] of PRODUCER_TRACKS) {
            expect(findStep(requireRoleRecipe(scenario, role), 'no-repair-dispatch')).toMatchObject({
                kind: 'wait',
                absent: true,
                timeoutMs: 5_000,
                match: {
                    kind: 'diagnostic',
                    topic: 'rallar.browser.alm.outbound_diagnostics',
                    contains: '"typeId":"alm.conformance.rtc-with-ws-fallback.subscription-ordered-omission","origin":"repair"'
                }
            });
        }
    });
});

/** The continuation's steps up to its stats read, named without its role's prefix, which its recipe id extends. */
function toContinuationStepNames(scenario: AlmConformanceScenario): readonly string[] {
    const recipe = scenario.continuation?.recipe;
    const prefix = `${recipe?.recipeId.replace(/-continuation$/, '')}-`;
    return (recipe?.commands ?? [])
        .map(({ commandId }) => (commandId ?? '').replace(prefix, ''))
        .filter((name) => name !== 'continuation-stats');
}

describe('ALM ordered subscription reconnect conformance', () => {
    it('holds back no continuation in any other topic subscription cell', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const continued = toTopicSubscriptionScenarios(carrier).filter(({ continuation }) => continuation !== undefined);
            expect(continued.map(({ scenarioId }) => scenarioId), carrier).toEqual(['subscription-ordered-reconnect']);
        }
    });

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'continues the closed sibling over %s once the receiver heard both producers\' p4, on the sibling\'s own agent',
        (carrier) => {
            const scenario = findOrderedScenario(carrier, 'subscription-ordered-reconnect');
            const prefix = `alm-${carrier}-subscription-ordered-reconnect`;
            const receiver = requireRoleRecipe(scenario, 'receiver');
            const gate = `${prefix}-receiver-cue-c-p4-confirmed-received`;

            expect(scenario.continuation?.role).toBe('sibling');
            expect(scenario.continuation?.gate).toEqual({ role: 'receiver', commandId: gate });
            expect(scenario.continuation?.recipe.recipeId).toBe(`${prefix}-sibling-continuation`);
            expect(receiver.commands.map(({ commandId }) => commandId)).toContain(gate);
            expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, scenario.continuation!.recipe)).toMatchObject({ ok: true });
            // The continuation runs on the sibling's open page, so its ids stay apart from the first recipe's.
            const continuation = toFlatCommands(scenario.continuation!.recipe.commands);
            const firstIds = new Set(toFlatCommands(requireRoleRecipe(scenario, 'sibling').commands).map(({ commandId }) => commandId));
            expect(continuation.filter(({ commandId }) => firstIds.has(commandId))).toEqual([]);
            expect(continuation.map(({ kind }) => kind)).not.toContain('rtc.connect');
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)('drops the sibling after p2 and re-enters it for p5 over %s', (carrier) => {
        const scenario = findOrderedScenario(carrier, 'subscription-ordered-reconnect');

        for (const [role, track] of PRODUCER_TRACKS) {
            expect(toStepNames(requireRoleRecipe(scenario, role)), role).toEqual([
                'cue-listen',
                'cue-listen-sent',
                ...toPublishSteps('probe-ready'),
                ...toPublishSteps(`${track}-p1`),
                ...toPublishSteps(`${track}-p2`),
                'sibling-left',
                ...toPublishSteps('probe-receiver-alone'),
                ...toPublishSteps(`${track}-p3`),
                ...toPublishSteps(`${track}-p4`),
                'cue-reentered-received',
                ...toPublishSteps('probe-reentered'),
                ...toPublishSteps(`${track}-p5`),
                'no-repair-dispatch',
                'no-gap-nack'
            ]);
        }
        expect(toStepNames(requireRoleRecipe(scenario, 'receiver'))).toEqual([
            'cue-listen',
            'cue-listen-sent',
            ...START_STATE_STEPS,
            'subscribe-receiver',
            ...toPublicationSteps('received', 'a', [1, 2]),
            ...toPublicationSteps('received', 'c', [1, 2]),
            ...toConfirmedCueSteps(2),
            ...toPublicationSteps('received', 'a', [3, 4]),
            ...toPublicationSteps('received', 'c', [3, 4]),
            ...toConfirmedCueSteps(4),
            ...toPublicationSteps('received', 'a', [5]),
            ...toPublicationSteps('received', 'c', [5]),
            ...toConfirmedCueSteps(5),
            'unsubscribe-receiver',
            'assert-unsubscribe-receiver-lapsed'
        ]);
        expect(toStepNames(requireRoleRecipe(scenario, 'sibling'))).toEqual([
            'cue-listen',
            'cue-listen-sent',
            'subscribe-sibling',
            'tokens-before-drop',
            ...toPublicationSteps('received', 'a', [1, 2]),
            ...toPublicationSteps('received', 'c', [1, 2]),
            ...toConfirmedCueSteps(2),
            'product-socket-close'
        ]);
        expect(toContinuationStepNames(scenario)).toEqual([
            'product-socket-reopen',
            'reasserted',
            'tokens-reconnected',
            'rows-reconnected',
            'presence-reasserted',
            'reentered-delta-margin',
            'cue-reentered',
            'cue-reentered-sent',
            ...toPublicationSteps('received', 'a', [5]),
            ...toPublicationSteps('received', 'c', [5]),
            'omitted-a-p5',
            'omitted-c-p5',
            ...toPublicationSteps('absent', 'a', [3, 4]),
            ...toPublicationSteps('absent', 'c', [3, 4]),
            ...toConfirmedCueSteps(5),
            'unsubscribe-sibling',
            'assert-unsubscribe-sibling-lapsed'
        ]);
    });

    it('each producer\'s alone-probe follows its own observation that the sibling\'s session left the room', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenario = findBarrieredReconnectScenario(carrier);
            for (const [role, track] of PRODUCER_TRACKS) {
                const producer = requireRoleRecipe(scenario, role);
                const armed = `${producer.recipeId}-armed`;
                const commandIds = producer.commands.map(({ commandId }) => commandId);
                const left = findStep(producer, 'sibling-left');

                expect(commandIds.indexOf(armed), `${carrier} ${role}`).toBeGreaterThan(-1);
                expect(commandIds.indexOf(left.commandId), `${carrier} ${role}`).toBeGreaterThan(commandIds.indexOf(armed));
                expect(commandIds.indexOf(left.commandId), `${carrier} ${role}`)
                    .toBeGreaterThan(commandIds.indexOf(`${producer.recipeId}-${track}-p2`));
                expect(commandIds.indexOf(`${producer.recipeId}-probe-receiver-alone`), `${carrier} ${role}`)
                    .toBeGreaterThan(commandIds.indexOf(left.commandId));
                // Four roles share the room, so the sibling's removal leaves three.
                expect(left).toMatchObject({
                    kind: 'wait',
                    match: {
                        kind: 'diagnostic',
                        topic: 'rallar.browser.group_state.applied',
                        payloadFields: {
                            'data.change': 'held',
                            'data.groupRef.applicationId': 'app',
                            'data.groupRef.workspaceId': 'ws',
                            'data.groupRef.groupId': 'room-alm',
                            'data.activeSessionCount': 3
                        },
                        sinceCommandIdPrefix: armed
                    }
                });
                expect(left).not.toHaveProperty('absent');
            }
        }
    });

    it('counts a session removal from the armed barrier onward, and no count the roles reached while connecting', async () => {
        const producer = requireRoleRecipe(findBarrieredReconnectScenario('rtc'), 'sender');
        const left = findStep(producer, 'sibling-left');
        const armed = {
            kind: 'result' as const,
            topic: 'rallar.bb.command.result',
            commandId: `${producer.recipeId}-armed`,
            severity: 'info' as const,
            payload: {}
        };
        const toApplied = (activeSessionCount: number) => ({
            kind: 'diagnostic' as const,
            topic: 'rallar.browser.group_state.applied',
            payload: {
                data: {
                    groupRef: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
                    groupRevision: 7,
                    presenceRevision: 9,
                    rosterVersion: 1,
                    activeSessionCount,
                    change: 'held'
                }
            }
        });

        expect(await runWaitAfterEvents(left, [toApplied(3), toApplied(4), armed])).toBe(false);
        expect(await runWaitAfterEvents(left, [toApplied(3), armed, toApplied(4)])).toBe(false);
        expect(await runWaitAfterEvents(left, [toApplied(4), armed, toApplied(3)])).toBe(true);
    });

    it('four-role cells always run in a room of their own', () => {
        const spec = readFileSync('tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts', 'utf8');

        expect(spec).toMatch(/family === 'four-role' \? toOwnRoomScenario\(run, carrier, planned\) : planned/);
        expect(spec).toContain('groupId: `${run.group.groupId}-${planned.scenarioKey}`');
        expect(spec).toMatch(/if \(family === 'four-role'\) \{\s+await closeAgentConnections\(run, scenario\.scenarioKey\);/);
    });

    it.each(
        [
            { carrier: 'ws', unelected: 0 },
            { carrier: 'rtc', unelected: 1 },
            { carrier: 'rtc-with-ws-fallback', unelected: 1 }
        ] as const
    )('expects the receiver alone while the sibling is closed over $carrier, both subscribers around it', ({ carrier, unelected }) => {
        const scenario = findOrderedScenario(carrier, 'subscription-ordered-reconnect');
        for (const [role, track] of PRODUCER_TRACKS) {
            const producer = requireRoleRecipe(scenario, role);

            for (const name of ['probe-ready', `${track}-p1`, `${track}-p2`, 'probe-reentered', `${track}-p5`]) {
                expect(toLoopCounts(producer, name), `${role} ${name}`).toEqual(toCounts(2, unelected));
            }
            for (const name of ['probe-receiver-alone', `${track}-p3`, `${track}-p4`]) {
                expect(toLoopCounts(producer, name), `${role} ${name}`).toEqual(toCounts(1, unelected));
            }
            expect(toLoopSend(producer, 'probe-receiver-alone'), role).not.toHaveProperty('orderingKey');
            expect(toLoopSend(producer, 'probe-reentered'), role).not.toHaveProperty('orderingKey');
            expect(toLoopSend(producer, `${track}-p5`), role).toMatchObject({ orderingKey: 'subscription-ordered-reconnect' });
        }
    });

    it('re-enters the sibling only once its reopened socket\'s generation names its row and its room presence', () => {
        const scenario = findOrderedScenario('ws', 'subscription-ordered-reconnect');
        const prefix = 'alm-ws-subscription-ordered-reconnect-sibling';
        const continuation = scenario.continuation!.recipe.commands;
        const children = (name: string) => {
            const poll = continuation.find(({ commandId }) => commandId === `${prefix}-${name}`);
            return poll?.kind === 'loop' ? poll.commands : [];
        };
        const reconnected = `"connectionGenerationId":"{resultCache.${prefix}-tokens-reconnected.value.connectionGenerationId}"`;

        expect(children('reasserted').at(-1)).toMatchObject({
            match: {
                topic: 'rallar.bb.messages.subscriptions',
                contains: `"connectionGenerationId":"{resultCache.${prefix}-tokens-before-drop.value.connectionGenerationId}"`
            },
            absent: true
        });
        expect(children('rows-reconnected').map(({ kind }) => kind)).toEqual(['http.request', 'assert', 'wait']);
        expect(children('rows-reconnected')[2]).toMatchObject({ match: { topic: 'rallar.bb.http.response', contains: reconnected } });
        // The room's presence names the session under the reopened socket: Task 4's re-assertion, read over REST.
        expect(children('presence-reasserted').map(({ kind }) => kind)).toEqual(['http.request', 'wait']);
        expect(children('presence-reasserted')[0]).toMatchObject({
            request: {
                method: 'GET',
                path: '/api/state/apps/app/workspaces/ws/groups/room-alm'
            }
        });
        expect(children('presence-reasserted')[1]).toMatchObject({ match: { topic: 'rallar.bb.http.response', contains: reconnected } });
        expect(children('presence-reasserted')[1]).not.toHaveProperty('absent');
        expect(continuation.find(({ commandId }) => commandId === `${prefix}-reentered-delta-margin`))
            .toMatchObject({ kind: 'wait', absent: true, timeoutMs: 2_000 });
    });

    it('reads the reopened sibling\'s p5 as an omission after p2 on each track, and p3 and p4 absent', () => {
        const scenario = findOrderedScenario('rtc', 'subscription-ordered-reconnect');
        const prefix = 'alm-rtc-subscription-ordered-reconnect-sibling';
        const continuation = scenario.continuation!.recipe.commands;
        const step = (name: string) => continuation.find(({ commandId }) => commandId === `${prefix}-${name}`);

        expect(step('omitted-c-p5')).toMatchObject({
            match: {
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.inbound_diagnostics',
                contains: `"trackKey":"subscription-ordered-reconnect:{resultCache.${prefix}-received-c-p5.value.event.payload.senderId}:`,
                payloadFields: { 'data.kind': 'ordering-position', 'data.status': 'omitted', 'data.priorSeq': 2 }
            }
        });
        expect(['a-p3', 'a-p4', 'c-p3', 'c-p4'].map((publication) => {
            const wait = step(`absent-${publication}`);
            return wait?.kind === 'wait' ? [wait.absent, wait.timeoutMs] : [];
        })).toEqual([[true, 5_000], [true, 0], [true, 0], [true, 0]]);
    });
});
