import { describe, expect, it } from 'vitest';

import {
    createPublicationWorkloadRecipes,
    type PublicationWorkloadRoomRecipes
} from '@shared-test/rallar-bb-test/conformance/alm/publication-workload/create-publication-workload-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import { distributedRecipePreflight } from '@shared-test/rallar-bb-test/distributed-recipe-preflight/distributed-recipe-preflight.ts';
import { resolveLoopPlan } from '@shared-test/rallar-bb-test/loop/resolve-loop-plan.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestLoopCommand,
    type RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/mod.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { toNestedCommands } from '../to-nested-commands.ts';
import {
    createRecipes,
    createRoles,
    createRooms,
    FILLER,
    FRAME_TYPE_ID,
    GROUP,
    POINT,
    QUARTER_LOSS,
    toCommandsAfterBarrier,
    WS_LOSS_POINT
} from './publication-workload-test-point.ts';

const SECOND_GROUP = { ...GROUP, groupId: 'workload-room-2' };

/** The loops at the top level of a recipe whose children send: a loop nested in another would be missing here. */
function toSendLoops(recipe: RallarBlackBoxTestRecipe): readonly RallarBlackBoxTestLoopCommand[] {
    return recipe.commands
        .filter((command) => command.kind === 'loop')
        .filter((loop) => loop.commands.some((child) => child.kind === 'messages.send'));
}

function toSoleSendLoop(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestLoopCommand {
    const [loop, ...others] = toSendLoops(recipe);
    if (loop === undefined || others.length > 0) {
        throw new Error(`The recipe ${recipe.recipeId} must hold exactly one top-level loop of sends.`);
    }
    return loop;
}

function toFaultInjects(recipe: RallarBlackBoxTestRecipe): readonly RallarBlackBoxTestCommand[] {
    return toNestedCommands(recipe.commands).filter((command) => command.kind === 'fault.inject');
}

function toBarrierIds(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    return recipe.commands.flatMap((command) => command.kind === 'barrier' ? [command.barrierId] : []);
}

/** The requests of a recipe that write: only the agent that creates the room's group has any. */
function toWriteRequests(recipe: RallarBlackBoxTestRecipe): readonly RallarBlackBoxTestCommand[] {
    return recipe.commands.filter((command) => command.kind === 'http.request' && command.request.method !== 'GET');
}

/** What an agent's recipe passes before it runs: the recipe schema, the control validation and the preflight. */
function expectRecipeAdmitted(recipe: RallarBlackBoxTestRecipe): void {
    expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe)).toEqual({ ok: true, errors: [] });
    expect(toNestedCommands(recipe.commands).map((command) => validateRallarBlackBoxTestCommand(command)))
        .toEqual(toNestedCommands(recipe.commands).map(() => ({ ok: true })));
    expect(distributedRecipePreflight(recipe).errors).toEqual([]);
}

describe('the recipes of one point of the publication workload family', () => {
    it('gives the publisher one loop of 60 frames 500 ms apart whose one child is the stamped live send, and has a subscriber count 57 copies and read their age', () => {
        const { publisher, subscriber } = createRecipes(POINT);

        const loop = toSoleSendLoop(publisher.recipe);
        expect(loop).toMatchObject({ count: 60, intervalMs: 500, continueOnFailure: true });
        expect(loop.commands).toEqual([{
            kind: 'messages.send',
            commandId: 'publication-workload-publisher-send',
            connection: 'publication-workload-publisher',
            carrier: 'rtc',
            roomRef: GROUP,
            topicId: 'room.publication-workload',
            typeId: FRAME_TYPE_ID,
            purpose: 'live',
            publication: { cadenceMs: 100, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } },
            resourceId: 'publication-workload',
            ttlMs: 5_000,
            payload: { seq: '{loop.iteration}', sentAtEpochMs: '{loop.atEpochMs}', pad: FILLER },
            // The harness's own budget for a send, not the frame's lifetime of 5,000 ms.
            timeoutMs: 10_000
        }]);
        expect(toNestedCommands(subscriber.recipe.commands).filter((command) => command.kind === 'messages.received'))
            .toEqual([{
                kind: 'messages.received',
                commandId: 'publication-workload-subscriber-received',
                connection: 'publication-workload-subscriber',
                typeId: FRAME_TYPE_ID,
                count: 57,
                ageFrom: 'sentAtEpochMs',
                windowMs: 5_000,
                timeoutMs: 6_000
            }]);
    });

    it.each(
        [
            { role: 'publisher', connection: 'publication-workload-publisher' },
            { role: 'subscriber', connection: 'publication-workload-subscriber' }
        ] as const
    )(
        'connects the $role once, under the connection its send or its count names, on the one typed channel of the frame',
        ({ role, connection }) => {
            const { recipe } = createRecipes(POINT)[role];

            const connects = recipe.commands.filter((command) => command.kind === 'rtc.connect');
            expect(connects).toHaveLength(1);
            expect(connects[0]).toMatchObject({ connection, transport: 'messages.rtc', roomRef: GROUP });
            expect(connects[0]?.rallar).toMatchObject({
                typeId: 'room.publication-workload.frame.v1',
                topicId: 'room.publication-workload'
            });
            expect(Object.keys(connects[0]?.rallar ?? {})).not.toContain('messageSelector');
            expect(Object.keys(connects[0]?.rallar ?? {})).not.toContain('messageTypeIds');
        }
    );

    it('returns the issues of a point that breaks its bounds and builds no recipe, though sizing its payload would throw', () => {
        const created = createPublicationWorkloadRecipes({ ...POINT, participantCount: 1, payloadBytes: 10 });

        expect(created.right).toBeUndefined();
        expect(created.left?.map(({ path, code }) => ({ path, code }))).toEqual([
            { path: '$.participantCount', code: 'invalid-participant-count' },
            { path: '$.payloadBytes', code: 'payload-bytes-below-template-minimum' }
        ]);
    });

    it.each(['ws', 'rtc', 'rtc-with-ws-fallback'] as const)(
        'sends on %s, with no loss and under a seeded loss, on recipes the schema, the control validation and the preflight all admit',
        (carrier) => {
            for (const loss of [{ kind: 'none' } as const, QUARTER_LOSS]) {
                const { publisher, subscriber } = createRecipes({ ...POINT, carrier, loss });

                expectRecipeAdmitted(publisher.recipe);
                expectRecipeAdmitted(subscriber.recipe);
                expect(
                    toNestedCommands(publisher.recipe.commands).flatMap((command) =>
                        command.kind === 'messages.send' && 'carrier' in command ? [command.carrier] : []
                    )
                ).toEqual([carrier]);
            }
        }
    );

    it.each(['ws', 'rtc', 'rtc-with-ws-fallback'] as const)(
        'gives a point of two publishers on %s, with no loss and under a seeded loss, three recipes the schema, the control validation and the preflight all admit',
        (carrier) => {
            for (const loss of [{ kind: 'none' } as const, QUARTER_LOSS]) {
                const roles = createRoles({ ...POINT, publisherCount: 2, carrier, loss });

                expect(roles).toHaveLength(3);
                roles.forEach(({ recipe }) => expectRecipeAdmitted(recipe));
            }
        }
    );

    it('holds a quarter loss from seed 7 on a ws publisher\'s frames from before its first send until its stage holds none, and releases it under the same fault id', () => {
        const { publisher } = createRecipes(WS_LOSS_POINT);

        const window = toCommandsAfterBarrier(publisher.recipe, 'publication-workload-setup-complete');
        expect(window.map((command) => command.commandId)).toEqual([
            'publication-workload-publisher-loss-arm',
            'publication-workload-publisher-frames',
            'publication-workload-publisher-drain',
            'publication-workload-publisher-loss-release',
            'publication-workload-publisher-stats',
            'publication-workload-publisher-complete',
            'publication-workload-publisher-assert-accepted-sends',
            'publication-workload-publisher-assert-loss-acted'
        ]);
        const fault = {
            kind: 'fault.inject',
            faultId: 'publication-workload-loss',
            carrier: 'ws',
            match: { typeId: FRAME_TYPE_ID },
            action: { loss: { ratio: 0.25, seed: 7 } },
            timeoutMs: 3_000
        };
        expect(window[0]).toEqual({ ...fault, commandId: 'publication-workload-publisher-loss-arm', remaining: 'until-cleared' });
        expect(window[3]).toEqual({ ...fault, commandId: 'publication-workload-publisher-loss-release', remaining: 0 });
        // The release's own count of the sends its fault dropped, read once the stage holds nothing of the window.
        expect(window[7]).toEqual({
            kind: 'assert',
            commandId: 'publication-workload-publisher-assert-loss-acted',
            source: 'resultCache.publication-workload-publisher-loss-release.value.acted.drop',
            operator: 'gte',
            expected: 1
        });
        expect(toFaultInjects(publisher.recipe)).toEqual([window[0], window[3]]);
    });

    it.each(['rtc', 'rtc-with-ws-fallback'] as const)('arms the loss on rtc for an %s point', (carrier) => {
        const { publisher } = createRecipes({ ...WS_LOSS_POINT, carrier });

        expect(toFaultInjects(publisher.recipe).map((command) => 'carrier' in command ? command.carrier : undefined))
            .toEqual(['rtc', 'rtc']);
    });

    it('arms nothing on a subscriber, and nothing on a publisher of a point with no loss', () => {
        const { publisher, subscriber } = createRecipes(POINT);

        expect(toFaultInjects(createRecipes(WS_LOSS_POINT).subscriber.recipe)).toEqual([]);
        expect(toFaultInjects(publisher.recipe)).toEqual([]);
        expect(toFaultInjects(subscriber.recipe)).toEqual([]);
    });

    it('meets every role of a loss point at the same complete barrier, whose timeout holds the two fault steps', () => {
        const recipes = createRoles({ ...WS_LOSS_POINT, publisherCount: 2 }).map((role) => role.recipe);

        // Twice the 30,000 ms window for the loop, the 5,100 ms drain, the 3,000 ms stats read, and 3,000 ms for each of
        // the arm and the release.
        for (const recipe of recipes) {
            expect(
                recipe.commands.find((command) => command.kind === 'barrier' && command.barrierId === 'publication-workload-complete'),
                recipe.recipeId
            ).toMatchObject({ timeoutMs: 74_100 });
        }
    });

    it.each([
        {
            split: '3 agents with 1 publisher into that publisher and 2 subscribers',
            point: { participantCount: 3, publisherCount: 1 },
            roleAgents: [['publisher', 1], ['subscriber', 2]]
        },
        {
            split: '50 agents with 1 publisher into that publisher and 49 subscribers',
            point: { participantCount: 50, publisherCount: 1 },
            roleAgents: [['publisher', 1], ['subscriber', 49]]
        },
        {
            split: '3 agents with 2 publishers into one publisher, 1 joining publisher and 1 subscriber',
            point: { participantCount: 3, publisherCount: 2 },
            roleAgents: [['publisher', 1], ['publisher', 1], ['subscriber', 1]]
        },
        {
            split: '15 agents with 5 publishers into one publisher, 4 joining publishers and 10 subscribers',
            point: { participantCount: 15, publisherCount: 5 },
            roleAgents: [['publisher', 1], ['publisher', 4], ['subscriber', 10]]
        }
    ])(
        'splits $split: the first publisher alone writes the group, and every role waits for all the agents',
        ({ point, roleAgents }) => {
            const { participantCount } = point;
            const [publisher, ...joining] = createRoles({ ...POINT, ...point });

            expect([publisher, ...joining].map((role) => [role.kind, role.agentCount])).toEqual(roleAgents);
            expect(toWriteRequests(publisher.recipe)[0])
                .toMatchObject({ request: { body: { groupId: 'workload-room', maxMembers: participantCount } } });
            expect(joining.flatMap(({ recipe }) => toWriteRequests(recipe))).toEqual([]);
            for (const { recipe } of [publisher, ...joining]) {
                expect(recipe.commands.find((command) => command.kind === 'wait' && command.absent !== true))
                    .toMatchObject({ match: { payloadFields: { 'data.activeSessionCount': participantCount } } });
            }
        }
    );

    it('gives a point of two publishers a joining publisher: it writes no group, connects once a peer exists under the publisher\'s connection, and runs the first publisher\'s window, barrier and gate', () => {
        const [publisher, joiningPublisher, subscriber] = createRoles({ ...POINT, publisherCount: 2 });

        expect([publisher, joiningPublisher, subscriber].map((role) => role.recipe.recipeId)).toEqual([
            'publication-workload-room-1-publisher',
            'publication-workload-room-1-joining-publisher',
            'publication-workload-room-1-subscriber'
        ]);
        const joining = joiningPublisher.recipe;
        expect(toWriteRequests(joining)).toEqual([]);
        const connects = joining.commands.filter((command) => command.kind === 'rtc.connect');
        expect(connects).toHaveLength(1);
        expect(connects[0]).toMatchObject({
            commandId: 'publication-workload-publisher-connect',
            connection: 'publication-workload-publisher',
            readiness: { minReadyPeers: 1 }
        });
        // The publisher that writes the group connects before any peer exists, so its connect waits for none.
        expect(publisher.recipe.commands.find((command) => command.kind === 'rtc.connect')).not.toHaveProperty('readiness');
        expect(toBarrierIds(joining)).toEqual([
            'publication-workload-group-created',
            'publication-workload-connected',
            'publication-workload-setup-complete',
            'publication-workload-complete'
        ]);
        const window = toCommandsAfterBarrier(joining, 'publication-workload-setup-complete');
        expect(window.map((command) => command.commandId)).toEqual([
            'publication-workload-publisher-frames',
            'publication-workload-publisher-drain',
            'publication-workload-publisher-stats',
            'publication-workload-publisher-complete',
            'publication-workload-publisher-assert-accepted-sends'
        ]);
        // Each publisher's gate is its own stage's count against 95 % of its own 60 frames.
        expect(window[4]).toMatchObject({ operator: 'gte', expected: 57 });
        expect(window).toEqual(toCommandsAfterBarrier(publisher.recipe, 'publication-workload-setup-complete'));
        expect(joining.eventHistory).toBeUndefined();
    });

    it('runs in a second room the commands of the same point in that room alone, under recipe ids of its own', () => {
        const [first, second] = createRooms({ ...POINT, groups: [GROUP, SECOND_GROUP] });
        const [alone] = createRooms({ ...POINT, groups: [SECOND_GROUP] });
        const toRecipes = (room: PublicationWorkloadRoomRecipes): readonly RallarBlackBoxTestRecipe[] => room.roles.map((role) => role.recipe);

        expect([first.group, second.group]).toEqual([GROUP, SECOND_GROUP]);
        expect([first, second].flatMap(toRecipes).map(({ recipeId, name }) => ({ recipeId, name }))).toEqual([
            { recipeId: 'publication-workload-room-1-publisher', name: 'Publication workload room 1 publisher' },
            { recipeId: 'publication-workload-room-1-subscriber', name: 'Publication workload room 1 subscriber' },
            { recipeId: 'publication-workload-room-2-publisher', name: 'Publication workload room 2 publisher' },
            { recipeId: 'publication-workload-room-2-subscriber', name: 'Publication workload room 2 subscriber' }
        ]);
        expect(second.roles.map(({ kind, agentCount, recipe }) => ({ kind, agentCount, commands: recipe.commands })))
            .toEqual(alone.roles.map(({ kind, agentCount, recipe }) => ({ kind, agentCount, commands: recipe.commands })));
        expect(toSoleSendLoop(toRecipes(second)[0]).commands[0]).toMatchObject({ roomRef: SECOND_GROUP });
        // Each room's commands name its own group id and never the other's.
        expect(JSON.stringify(toRecipes(second).map((recipe) => recipe.commands))).not.toContain('"workload-room"');
        expect(JSON.stringify(toRecipes(first).map((recipe) => recipe.commands))).not.toContain('"workload-room-2"');
    });

    it('meets every role of both rooms at the same four barriers with the same timeouts', () => {
        const recipes = createRooms({ ...POINT, publisherCount: 2, groups: [GROUP, SECOND_GROUP] })
            .flatMap((room) => room.roles.map((role) => role.recipe));

        expect(recipes).toHaveLength(6);
        for (const recipe of recipes) {
            expect(
                recipe.commands.flatMap((command) => command.kind === 'barrier' ? [{ barrierId: command.barrierId, timeoutMs: command.timeoutMs }] : []),
                recipe.recipeId
            ).toEqual([
                { barrierId: 'publication-workload-group-created', timeoutMs: 45_000 },
                // A joining agent's connect: the SDK connect and the room join at 45,000 ms each with a 5,000 ms
                // margin, then its readiness of 45,000 ms and 650 ms for each of the room's 3 agents.
                { barrierId: 'publication-workload-connected', timeoutMs: 141_950 },
                // The 45,000 ms to settle and one held reshape of 60,000 ms.
                { barrierId: 'publication-workload-setup-complete', timeoutMs: 105_000 },
                // Twice the 30,000 ms window for the loop, the 5,100 ms drain and the 3,000 ms stats read.
                { barrierId: 'publication-workload-complete', timeoutMs: 68_100 }
            ]);
        }
    });

    it('gives the stretch rung of five rooms of ten ten recipes for its 50 agents, each one the schema, the control validation and the preflight admit', () => {
        const groups = ['a', 'b', 'c', 'd', 'e'].map((room) => ({ ...GROUP, groupId: `workload-room-${room}` }));
        const roles = createRooms({ ...POINT, groups, participantCount: 10 }).flatMap((room) => room.roles);

        expect(roles.map((role) => role.agentCount)).toEqual([1, 9, 1, 9, 1, 9, 1, 9, 1, 9]);
        expect(new Set(roles.map((role) => role.recipe.recipeId)).size).toBe(10);
        roles.forEach(({ recipe }) => expectRecipeAdmitted(recipe));
    });

    it('meets both roles at the same four barriers, in order, under command ids of their own', () => {
        const { publisher, subscriber } = createRecipes(POINT);

        const barrierIds = [
            'publication-workload-group-created',
            'publication-workload-connected',
            'publication-workload-setup-complete',
            'publication-workload-complete'
        ];
        expect(toBarrierIds(publisher.recipe)).toEqual(barrierIds);
        expect(toBarrierIds(subscriber.recipe)).toEqual(barrierIds);
        const publisherCommandIds = toNestedCommands(publisher.recipe.commands).map((command) => command.commandId);
        const subscriberCommandIds = toNestedCommands(subscriber.recipe.commands).map((command) => command.commandId);
        expect(publisherCommandIds.filter((commandId) => subscriberCommandIds.includes(commandId))).toEqual([]);
    });

    it('starts the window at the setup-complete barrier: the publisher sends, drains and reads its stats, a subscriber waits at the complete barrier through all of it, and keeps its whole inbound log', () => {
        const { publisher, subscriber } = createRecipes(POINT);

        // Twice the 30,000 ms window for the loop, the 5,100 ms drain and the 3,000 ms stats read.
        const completeBarrier = { kind: 'barrier', barrierId: 'publication-workload-complete', timeoutMs: 68_100 };
        const publisherWindow = toCommandsAfterBarrier(publisher.recipe, 'publication-workload-setup-complete');
        expect(publisherWindow.map((command) => command.commandId)).toEqual([
            'publication-workload-publisher-frames',
            'publication-workload-publisher-drain',
            'publication-workload-publisher-stats',
            'publication-workload-publisher-complete',
            'publication-workload-publisher-assert-accepted-sends'
        ]);
        expect(publisherWindow[3]).toMatchObject(completeBarrier);
        // The stage's own count of the values it handed to a carrier, against 95 % of 60 frames.
        expect(publisherWindow[4]).toEqual({
            kind: 'assert',
            commandId: 'publication-workload-publisher-assert-accepted-sends',
            source: 'resultCache.publication-workload-publisher-stats.value.rallar.alm.publication.counters.admitted',
            operator: 'gte',
            expected: 57
        });
        expect(toCommandsAfterBarrier(subscriber.recipe, 'publication-workload-setup-complete')[0])
            .toMatchObject(completeBarrier);
        expect(subscriber.recipe.eventHistory).toEqual({ mode: 'full' });
    });
});

describe('the frame limit of the family against the loop\'s own limit', () => {
    it('fills the loop\'s expansion limit exactly at 2,000 frames, because the loop holds one send per frame', () => {
        const loop = toSoleSendLoop(createRecipes({ ...POINT, windowMs: 1_000_000 }).publisher.recipe);

        expect(loop.commands).toHaveLength(1);
        expect(loop.count).toBe(RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands);
        expect(resolveLoopPlan({ ...loop, commandId: 'frames' }).right?.plannedCommandCount)
            .toBe(RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands);
        expect(resolveLoopPlan({ ...loop, commandId: 'frames', count: 2_001 }).left?.error?.code)
            .toBe('RALLAR_BLACK_BOX_LOOP_LIMIT_EXCEEDED');
        expect(createPublicationWorkloadRecipes({ ...POINT, windowMs: 1_000_500 }).left?.map((issue) => issue.code))
            .toEqual(['frame-count-above-limit']);
    });
});
