import {
    describe,
    expect,
    it
} from 'vitest';

import type {
    ArenaMatchLifecycleMessage,
    ArenaMatchPlayerBaseline,
    ArenaMatchState,
    GameRealtimeMessage
} from '../../../apps/ar-eye-hunter-v1/src/game/types.ts';
import { createAlmScaleRecipes } from '../../shared-test/rallar-bb-test/conformance/alm/scale/create-alm-scale-recipes.ts';
import type { RallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '../../shared-test/rallar-bb-test/schema.ts';
import { isJsonRecordValue, validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { toOverlayLayoutIdentity } from '../../shared/repository/overlays-repository.ts';

const GROUP = { applicationId: 'scale-app', workspaceId: 'scale-workspace', groupId: 'scale-room' };

function flattenCommands(commands: readonly RallarBlackBoxTestCommand[]): readonly RallarBlackBoxTestCommand[] {
    return commands.flatMap((command) => [
        command,
        ...(command.kind === 'loop'
            ? flattenCommands(command.commands)
            : command.kind === 'parallel'
            ? command.groups.flatMap((group) => flattenCommands(group.commands))
            : [])
    ]);
}

function createExpectedMatch(): ArenaMatchState {
    const baseline: Record<string, ArenaMatchPlayerBaseline> = {};
    for (let index = 1; index <= 15; index++) {
        baseline[`fixture-player-${index}`] = {
            sessionId: `fixture-player-${index}`,
            username: `Player ${index}`,
            score: 0,
            kills: 0,
            deaths: 0,
            joinedOrder: index
        };
    }
    return {
        matchId: 'match:scale-room:1802088000000:60000',
        status: 'active',
        durationMs: 60_000,
        directorSessionId: '{auth.sessionId}',
        startedAtEpochMs: 1_802_088_000_000,
        endsAtEpochMs: 1_802_088_060_000,
        baseline
    };
}

function createExpectedLifecycleMessages(): readonly ArenaMatchLifecycleMessage[] {
    const match = createExpectedMatch();
    return [
        {
            protocol: 'ar-eye-hunter.v1',
            kind: 'director-match-started',
            accepted: {
                intent: {
                    matchId: 'match:scale-room:1802088000000:60000',
                    directorSessionId: '{auth.sessionId}',
                    durationMs: 60_000,
                    sentAtEpochMs: 1_802_088_000_000
                },
                match,
                revision: 1,
                acceptedAtEpochMs: 1_802_088_000_000
            }
        },
        {
            protocol: 'ar-eye-hunter.v1',
            kind: 'director-match-ended',
            accepted: {
                match: {
                    ...match,
                    status: 'complete',
                    completedAtEpochMs: 1_802_088_060_000,
                    results: createExpectedMatchResults()
                },
                revision: 2,
                acceptedAtEpochMs: 1_802_088_060_000
            }
        }
    ];
}

function createExpectedMatchResults(): NonNullable<ArenaMatchState['results']> {
    return Array.from({ length: 15 }, (_, index) => ({
        sessionId: `fixture-player-${index + 1}`,
        username: `Player ${index + 1}`,
        scoreDelta: 0,
        killsDelta: 0,
        deathsDelta: 0,
        rank: index + 1
    }));
}

describe('ALM scale recipes', () => {
    it.each([15, 30, 50] as const)('declares complete receipt audiences and valid commands for %i participants', (participantCount) => {
        const scale = createAlmScaleRecipes({ participantCount, group: GROUP, readyTimeoutMs: 45_000, almDiagnostics: false });

        expect(scale.recipes.map((recipe) => recipe.recipeId)).toEqual(['alm-scale-director', 'alm-scale-player']);
        expect(scale.metadata).toMatchObject({
            participantCount,
            senderCount: 1,
            receiverCount: participantCount - 1,
            shotsPerPlayer: 6,
            sampleCount: 7,
            intervalMs: 5_000,
            samplingWindowMs: 30_000
        });
        expect(scale.metadata).toMatchObject({
            workloadWindowMs: 30_000,
            arrivalChecks: {
                director: { commandId: 'alm-scale-director-shot-arrivals', iterations: 6, passed: (participantCount - 1) * 6 * 3 },
                player: { commandIds: ['alm-scale-player-started-arrival', 'alm-scale-player-ended-arrival'] }
            }
        });
        for (const recipe of scale.recipes) {
            expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe)).toEqual({ ok: true, errors: [] });
            const commands = flattenCommands(recipe.commands);
            const connect = commands.find((command) => command.kind === 'rtc.connect');
            expect(connect).toMatchObject({
                roomRef: GROUP,
                transport: 'messages.rtc',
                rallar: {
                    username: '{auth.username}',
                    password: '',
                    restoreSession: true,
                    timeoutMs: 45_000,
                    topicId: 'room.ar-eye-hunter.director',
                    messageSelector: { topicId: 'room.ar-eye-hunter.director' },
                    messageTypeIds: ['room.ar-eye-hunter.director.intent.v1', 'room.ar-eye-hunter.director.event.v1']
                }
            });
            const trafficIndex = recipe.commands.findIndex((command) => command.kind === 'parallel');
            const resetIndex = recipe.commands.findIndex((command) => command.kind === 'storage.counters' && command.reset);
            expect(resetIndex).toBeGreaterThan(0);
            expect(resetIndex).toBeLessThan(trafficIndex);
            expect(recipe.commands.slice(resetIndex + 1, trafficIndex)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'barrier', barrierId: 'alm-scale-traffic-ready' })
            ]));
            expect(commands).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: 'parallel',
                    maxConcurrency: 7,
                    groups: expect.arrayContaining([
                        expect.objectContaining({ groupId: 'sample-7' })
                    ])
                }),
                expect.objectContaining({ kind: 'parallel', maxConcurrency: 2 }),
                expect.objectContaining({ kind: 'barrier', barrierId: 'alm-scale-shots-complete' }),
                expect.objectContaining({ kind: 'director.status', refresh: 'when-absent' }),
                expect.objectContaining({
                    kind: 'wait',
                    match: expect.objectContaining({
                        payloadFields: expect.objectContaining({ 'data.activeSessionCount': participantCount })
                    })
                })
            ]));
            for (const send of commands.filter((command) => command.kind === 'messages.send')) {
                expect(send).toMatchObject({
                    reliability: 'at-least-once',
                    durability: 'volatile',
                    ttlMs: 30_000,
                    carrier: 'rtc-with-ws-fallback',
                    roomRef: GROUP
                });
                expect(send).not.toHaveProperty('toPeer');
                expect(send).not.toHaveProperty('recipientPeer');
            }
        }
        expect(scale.groupAssertions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                source: { recipeId: 'alm-scale-director', commandId: 'alm-scale-director-shot-arrivals', path: 'passed' },
                predicate: { operator: 'equals', expected: (participantCount - 1) * 6 * 3 }
            }),
            expect.objectContaining({
                source: { recipeId: 'alm-scale-player', commandId: 'alm-scale-player-window', path: 'groups.0.durationMs' },
                predicate: { operator: 'lt', expected: 30_000 }
            }),
            expect.objectContaining({
                scope: { role: 'sender' },
                source: {
                    recipeId: 'alm-scale-director',
                    commandId: 'alm-scale-director-start-receipt',
                    path: 'expectedRecipientPeerIds.length'
                },
                predicate: { operator: 'equals', expected: participantCount - 1 }
            }),
            expect.objectContaining({
                scope: { role: 'receiver' },
                source: {
                    recipeId: 'alm-scale-player',
                    commandId: 'alm-scale-player-shots',
                    path: 'iterations'
                },
                predicate: { operator: 'equals', expected: 6 }
            })
        ]));
        expect(scale.groupAssertions).toHaveLength(231);
        for (const assertion of scale.groupAssertions) {
            const recipe = scale.recipes.find((recipe) => recipe.recipeId === assertion.source.recipeId)!;
            const sources = flattenCommands(recipe.commands).filter((command) => command.commandId === assertion.source.commandId);
            expect(sources).toHaveLength(1);
            expect(assertion.source.commandId).not.toMatch(/sample-stats|shot-receipt/);
        }
    });

    it.each(['director', 'player'] as const)('signs the %s in under the 45 s setup allowance before any group request', (role) => {
        const scale = createAlmScaleRecipes({ participantCount: 15, group: GROUP, readyTimeoutMs: 45_000, almDiagnostics: false });
        const recipe = scale.recipes.find((candidate) => candidate.recipeId === `alm-scale-${role}`)!;

        expect(recipe.commands[0]).toMatchObject({
            kind: 'http.request',
            commandId: `alm-scale-${role}-sign-in`,
            request: { method: 'GET', path: '/api/state/apps/scale-app/workspaces/scale-workspace/stats/me/realtime' },
            response: { acceptedStatusCodes: [200] },
            timeoutMs: 45_000
        });
        const groupRequests = flattenCommands(recipe.commands).filter((command) => command.kind === 'http.request').slice(1);
        expect(groupRequests.map((command) => [command.commandId, command.timeoutMs])).toEqual(
            role === 'director'
                ? [['alm-scale-director-ensure-group', 8_750], ['alm-scale-director-ensure-member', 8_750]]
                : []
        );
    });

    it.each([15, 30, 50] as const)(
        'creates the %i-member scale group under the default replanning with the cohort as its capacity, so its last join replans at once (D288)',
        (participantCount) => {
            const scale = createAlmScaleRecipes({ participantCount, group: GROUP, readyTimeoutMs: 45_000, almDiagnostics: false });
            const ensureGroup = flattenCommands(scale.recipes[0].commands).find((command) => command.commandId === 'alm-scale-director-ensure-group');

            expect(ensureGroup).toMatchObject({
                request: {
                    method: 'POST',
                    body: { groupId: 'scale-room', displayName: 'scale-room', kind: 'room', joinMode: 'open', maxMembers: participantCount }
                }
            });
        }
    );

    it('creates the scale group under the default replanning, one plan after the join stream, because hosted acceptances of capped-debounce plans queued behind the joins', () => {
        const scale = createAlmScaleRecipes({ participantCount: 50, group: GROUP, readyTimeoutMs: 45_000, almDiagnostics: false });
        const ensureGroup = flattenCommands(scale.recipes[0].commands).find((command) => command.commandId === 'alm-scale-director-ensure-group');

        expect(ensureGroup?.kind === 'http.request' ? ensureGroup.request.body : undefined).not.toHaveProperty('lifecyclePolicy');
    });

    it.each([[15, 54_750], [30, 64_500], [50, 77_500]] as const)(
        'allows the %i-member cohort\'s player connect and connected barrier %i ms, 650 ms per participant beyond the setup allowance, because the hosted lane serves about 1.5 joining players per second at 50 members',
        (participantCount, allowanceMs) => {
            const scale = createAlmScaleRecipes({ participantCount, group: GROUP, readyTimeoutMs: 45_000, almDiagnostics: false });
            const [director, player] = scale.recipes.map((recipe) => flattenCommands(recipe.commands));
            const byId = (commands: readonly RallarBlackBoxTestCommand[], commandId: string) => commands.find((command) => command.commandId === commandId);

            expect(byId(player, 'alm-scale-player-connect')).toMatchObject({
                timeoutMs: allowanceMs,
                readiness: { minReadyPeers: 1, timeoutMs: allowanceMs - 5_000 },
                rallar: { timeoutMs: 45_000 }
            });
            expect(byId(director, 'alm-scale-director-connect')).toMatchObject({ timeoutMs: 50_000, rallar: { timeoutMs: 45_000 } });
            expect([byId(director, 'alm-scale-director-connected'), byId(player, 'alm-scale-player-connected')]).toEqual([
                expect.objectContaining({ barrierId: 'alm-scale-connected', timeoutMs: allowanceMs }),
                expect.objectContaining({ barrierId: 'alm-scale-connected', timeoutMs: allowanceMs })
            ]);
            expect(byId(player, 'alm-scale-player-group-created')).toMatchObject({ timeoutMs: 45_000 });
        }
    );

    it('appoints the director on its own connection before the group-created barrier releases the players, who join the room inside their connect', () => {
        const scale = createAlmScaleRecipes({ participantCount: 30, group: GROUP, readyTimeoutMs: 45_000, almDiagnostics: false });
        const [director, player] = scale.recipes;

        expect(director.commands.slice(0, 6).map((command) => command.commandId)).toEqual([
            'alm-scale-director-sign-in',
            'alm-scale-director-ensure-group',
            'alm-scale-director-ensure-member',
            'alm-scale-director-connect',
            'alm-scale-director-appoint',
            'alm-scale-director-group-created'
        ]);
        expect(director.commands[3]).not.toHaveProperty('readiness');
        expect(flattenCommands(director.commands).filter((command) => command.kind === 'director.appoint')).toHaveLength(1);
        expect(player.commands.slice(0, 3).map((command) => command.commandId)).toEqual([
            'alm-scale-player-sign-in',
            'alm-scale-player-group-created',
            'alm-scale-player-connect'
        ]);
        expect(player.commands[2]).toMatchObject({ roomId: 'scale-room', readiness: { minReadyPeers: 1 } });
    });

    it.each([[15, 'director'], [50, 'player']] as const)(
        'waits once, after the connected barrier, for the %i-member %s page to hold every cohort session in its WS-fed room snapshot instead of polling the group over REST',
        (participantCount, role) => {
            const scale = createAlmScaleRecipes({ participantCount, group: GROUP, readyTimeoutMs: 45_000, almDiagnostics: false });
            const recipe = scale.recipes.find((candidate) => candidate.recipeId === `alm-scale-${role}`)!;
            const prefix = `alm-scale-${role}`;
            const connected = recipe.commands.findIndex((command) => command.commandId === `${prefix}-connected`);
            const groupReads = flattenCommands(recipe.commands).filter((command) =>
                command.kind === 'http.request' && command.request.method === 'GET' && command.request.path?.includes('/groups/') === true
            );

            expect(groupReads).toEqual([]);
            expect(recipe.commands[connected + 1]).toEqual({
                kind: 'wait',
                commandId: `${prefix}-audience-ready`,
                timeoutMs: 45_000,
                match: {
                    kind: 'diagnostic',
                    topic: 'rallar.browser.formation.changed',
                    payloadFields: {
                        'data.roomRef.applicationId': GROUP.applicationId,
                        'data.roomRef.workspaceId': GROUP.workspaceId,
                        'data.roomRef.groupId': GROUP.groupId,
                        'data.activeSessionCount': participantCount
                    }
                }
            });
            expect(recipe.commands[connected + 2]).toMatchObject({ kind: 'barrier', barrierId: 'alm-scale-appointed' });
        }
    );

    it.each([15, 30, 50] as const)(
        'allows the %i-member cohort\'s joins, the director\'s group requests and each player\'s room join inside its connect, more than their serial cost at the 4 joins per second measured hosted',
        (participantCount) => {
            const hostedJoinsPerSecond = 4;
            const serialJoinCostMs = participantCount / hostedJoinsPerSecond * 1_000;
            const scale = createAlmScaleRecipes({ participantCount, group: GROUP, readyTimeoutMs: 45_000, almDiagnostics: false });
            const requests = scale.recipes.flatMap((recipe) => flattenCommands(recipe.commands))
                .filter((command) => command.kind === 'http.request');
            const timeoutOf = (suffix: string) => requests.filter((command) => command.commandId?.endsWith(suffix)).map((command) => command.timeoutMs);

            const roomJoins = flattenCommands(scale.recipes[1].commands)
                .filter((command) => command.kind === 'rtc.connect')
                .map((command) => command.rallar?.timeoutMs);
            expect(roomJoins).toHaveLength(1);
            for (const allowance of [...timeoutOf('-ensure-group'), ...timeoutOf('-ensure-member'), ...roomJoins]) {
                expect(allowance).toBeGreaterThan(serialJoinCostMs);
                expect(allowance).toBeGreaterThanOrEqual(5_000);
                expect(allowance).toBeLessThanOrEqual(45_000);
            }
        }
    );

    it.each([[15, 8_750], [30, 12_500], [50, 17_500]] as const)(
        'allows the %i-member cohort\'s single ready-status read %i ms like its group requests, because hosted it queues behind the formation burst on the serial lane, while the director-ready loop retries at 5 s',
        (participantCount, allowanceMs) => {
            const scale = createAlmScaleRecipes({ participantCount, group: GROUP, readyTimeoutMs: 45_000, almDiagnostics: false });

            for (const [role, recipe] of [['director', scale.recipes[0]], ['player', scale.recipes[1]]] as const) {
                const commands = flattenCommands(recipe.commands);
                expect(commands.find((command) => command.commandId === `alm-scale-${role}-ready-status`)).toMatchObject({
                    kind: 'director.status',
                    refresh: 'when-absent',
                    timeoutMs: allowanceMs
                });
                expect(commands.find((command) => command.commandId === `alm-scale-${role}-director-status`)).toMatchObject({
                    kind: 'director.status',
                    refresh: 'when-absent',
                    timeoutMs: 5_000
                });
                expect(commands.filter((command) => command.kind === 'director.status' && command.refresh === true)).toEqual([]);
            }
        }
    );

    it.each(['director', 'player'] as const)(
        'holds the %s at setup-complete until no newer plan has replaced the ready layout for a quiet window counted from when the page held it',
        (role) => {
            const scale = createAlmScaleRecipes({ participantCount: 50, group: GROUP, readyTimeoutMs: 45_000, almDiagnostics: false });
            const recipe = scale.recipes.find((candidate) => candidate.recipeId === `alm-scale-${role}`)!;
            const prefix = `alm-scale-${role}`;
            const setupComplete = recipe.commands.findIndex((command) => command.commandId === `${prefix}-setup-complete`);

            expect(recipe.commands[setupComplete - 3]).toMatchObject({ kind: 'director.status', commandId: `${prefix}-ready-status` });
            // Without an accepted layout the setup fails within seconds instead of spending the stable-layout allowance.
            expect(recipe.commands[setupComplete - 2]).toEqual({
                kind: 'loop',
                commandId: `${prefix}-layout-accepted`,
                count: 10,
                intervalMs: 500,
                timeoutMs: 10_000,
                until: 'first-success',
                commands: [
                    { kind: 'formation.readiness', commandId: `${prefix}-layout-accepted-readiness`, roomRef: GROUP, timeoutMs: 5_000 },
                    {
                        kind: 'assert',
                        commandId: `${prefix}-assert-layout-accepted`,
                        operator: 'exists',
                        source: `resultCache.${prefix}-layout-accepted:i{loop.iteration}:c1:` +
                            `${prefix}-layout-accepted-readiness.value.acceptedHeldSinceEpochMs`
                    }
                ]
            });
            expect(recipe.commands[setupComplete - 1]).toEqual({
                kind: 'loop',
                commandId: `${prefix}-layout-stable`,
                count: 90,
                intervalMs: 500,
                timeoutMs: 48_500,
                until: 'first-success',
                commands: [
                    { kind: 'formation.readiness', commandId: `${prefix}-layout-readiness`, roomRef: GROUP, timeoutMs: 5_000 },
                    {
                        kind: 'wait',
                        commandId: `${prefix}-layout-replan`,
                        absent: true,
                        timeoutMs: 3_500,
                        timeoutFrom: `{resultCache.${prefix}-layout-stable:i{loop.iteration}:c1:` +
                            `${prefix}-layout-readiness.value.acceptedHeldSinceEpochMs}`,
                        match: {
                            topic: 'rallar.browser.formation.layout',
                            payloadFields: { 'data.kind': 'layoutPlanned', 'data.role': 'planned' },
                            payloadPath: 'data.identity',
                            contains: `"groupRevision":{resultCache.${prefix}-layout-stable:i{loop.iteration}:c1:` +
                                `${prefix}-layout-readiness.value.formation.causalRevision.groupRevision},`
                        }
                    }
                ]
            });
        }
    );

    it('matches a re-plan from exactly the ready revision because the layout event serializes its group revision first', () => {
        const identity = toOverlayLayoutIdentity({
            sourceGroupStateCausalRevision: { groupRevision: 56, presenceRevision: 7 },
            provenance: 'server',
            state: 'active',
            overlayId: 'overlay-1',
            groupRef: GROUP,
            topology: 'tree',
            name: 'scale-room',
            createdByClientId: 'director',
            createdAtEpochMs: 1_000,
            nextHopSessionIds: [],
            degreeLimit: 4,
            overlayVersion: 5,
            updatedAtEpochMs: 1_000,
            nextHopsBySessionId: {}
        });

        expect(JSON.stringify(identity)).toMatch(/^\{"groupRevision":56,"presenceRevision"/);
    });

    it.each([false, true])('connects both roles with the ALM diagnostic stream %s', (almDiagnostics) => {
        const scale = createAlmScaleRecipes({ participantCount: 15, group: GROUP, readyTimeoutMs: 45_000, almDiagnostics });

        const connects = scale.recipes.flatMap((recipe) => flattenCommands(recipe.commands))
            .filter((command) => command.kind === 'rtc.connect');
        expect(connects.map((command) => command.rallar?.almDiagnostics)).toEqual([almDiagnostics, almDiagnostics]);
    });

    it('authors coherent AR Eye shot and completed-match wire specimens', () => {
        const scale = createAlmScaleRecipes({ participantCount: 15, group: GROUP, readyTimeoutMs: 45_000, almDiagnostics: false });
        const playerCommands = flattenCommands(scale.recipes[1].commands);
        const shots = playerCommands.filter((command) => command.kind === 'messages.send');
        expect(shots).toHaveLength(6);
        expect(shots.map((command) => 'handleId' in command ? command.handleId : undefined)).toEqual(
            Array.from({ length: 6 }, (_, index) => `alm-scale-player-shot-${index + 1}`)
        );
        const shot = shots[2];
        expect(shot).toMatchObject({
            ack: 'group-leader',
            handleId: 'alm-scale-player-shot-3',
            payload: {
                protocol: 'rallar.director.relay.v1',
                roomId: 'scale-room',
                typeId: 'room.ar-eye-hunter.director.intent.v1',
                payload: {
                    protocol: 'ar-eye-hunter.v1',
                    kind: 'intent',
                    senderId: '{auth.sessionId}',
                    seq: 3,
                    payload: {
                        protocol: 'ar-eye-hunter.v1',
                        kind: 'player-shot-intent',
                        shot: {
                            sessionId: '{auth.sessionId}',
                            seq: 3,
                            origin: [0, 1.6, 0],
                            direction: [0, 0, 1],
                            weaponKind: 'pulse-rifle'
                        }
                    }
                }
            }
        });
        const expectedShot: GameRealtimeMessage = {
            protocol: 'ar-eye-hunter.v1',
            kind: 'player-shot-intent',
            shot: {
                sessionId: '{auth.sessionId}',
                username: '{auth.username}',
                color: '#55ccff',
                origin: [0, 1.6, 0],
                direction: [0, 0, 1],
                weaponKind: 'pulse-rifle',
                charged: false,
                overdrive: false,
                seq: 3,
                sentAtEpochMs: 1_802_088_000_000
            }
        };
        expect(shot).toMatchObject({ payload: { payload: { payload: expectedShot } } });
        const events = flattenCommands(scale.recipes[0].commands).filter((command) => command.kind === 'messages.send');
        expect(events).toHaveLength(2);
        const messages = events.map((event) => {
            expect(event).toMatchObject({
                ack: 'all-logical-recipients',
                payload: {
                    payload: {
                        kind: 'event',
                        senderId: '{auth.sessionId}',
                        roomId: 'scale-room'
                    }
                }
            });
            if (!('payload' in event) || !isJsonRecordValue(event.payload) || !isJsonRecordValue(event.payload.payload)) {
                throw new Error('Invalid relay/game envelope');
            }
            return event.payload.payload.payload;
        });
        expect(messages).toEqual(createExpectedLifecycleMessages());
        expect(playerCommands).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'messages.received', typeId: 'room.ar-eye-hunter.director.event.v1', count: 2 })
        ]));
        expect(flattenCommands(scale.recipes[0].commands)).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'messages.received', typeId: 'room.ar-eye-hunter.director.intent.v1', count: 84 })
        ]));
    });
});
