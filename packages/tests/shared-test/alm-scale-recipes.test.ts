import { describe, expect, it } from 'vitest';

import type {
    ArenaMatchLifecycleMessage,
    ArenaMatchPlayerBaseline,
    ArenaMatchState,
    GameRealtimeMessage
} from '../../../apps/ar-eye-hunter-v1/src/game/types.ts';
import { createAlmScaleRecipes } from '../../shared-test/rallar-bb-test/conformance/alm/scale/create-alm-scale-recipes.ts';
import { toLoopChildCommand } from '../../shared-test/rallar-bb-test/loop/to-loop-child-command.ts';
import type { RallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '../../shared-test/rallar-bb-test/schema.ts';
import { isJsonRecordValue, validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

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
                    results: Array.from(
                        { length: 15 },
                        (_, index) => ({
                            sessionId: `fixture-player-${index + 1}`,
                            username: `Player ${index + 1}`,
                            scoreDelta: 0,
                            killsDelta: 0,
                            deathsDelta: 0,
                            rank: index + 1
                        })
                    )
                },
                revision: 2,
                acceptedAtEpochMs: 1_802_088_060_000
            }
        }
    ];
}

describe('ALM scale recipes', () => {
    it.each([15, 30, 50] as const)('declares complete receipt audiences and valid commands for %i participants', (participantCount) => {
        const scale = createAlmScaleRecipes({ participantCount, group: GROUP, readyTimeoutMs: 45_000 });

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
                readiness: { minReadyPeers: 1, timeoutMs: 45_000 },
                rallar: {
                    username: '{auth.username}',
                    password: '',
                    restoreSession: true,
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
                expect.objectContaining({ kind: 'loop', count: 7, intervalMs: 5_000 }),
                expect.objectContaining({ kind: 'parallel', maxConcurrency: 2 }),
                expect.objectContaining({ kind: 'barrier', barrierId: 'alm-scale-shots-complete' }),
                expect.objectContaining({ kind: 'director.status', refresh: true }),
                expect.objectContaining({ kind: 'assert', source: expect.stringContaining('body.activeSessions.length'), expected: participantCount })
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
        for (const assertion of scale.groupAssertions) {
            const recipe = scale.recipes.find((recipe) => recipe.recipeId === assertion.source.recipeId)!;
            const sources = flattenCommands(recipe.commands).filter((command) => command.commandId === assertion.source.commandId);
            expect(sources).toHaveLength(1);
            expect(assertion.source.commandId).not.toMatch(/sample-stats|shot-receipt/);
        }
    });

    it('authors coherent AR Eye shot and completed-match wire specimens', () => {
        const scale = createAlmScaleRecipes({ participantCount: 15, group: GROUP, readyTimeoutMs: 45_000 });
        const playerCommands = flattenCommands(scale.recipes[1].commands);
        const shotLoop = playerCommands.find((command) => command.kind === 'loop' && command.count === 6)!;
        expect(shotLoop.kind).toBe('loop');
        if (shotLoop.kind !== 'loop') {
            throw new Error('Missing shot loop');
        }
        const shotTemplate = shotLoop.commands.find((command) => command.kind === 'messages.send')!;
        const shot = toLoopChildCommand({
            template: shotTemplate,
            context: {
                loopCommandId: 'shots',
                index: 2,
                iteration: 3,
                elapsedMs: 10_000,
                commandIndex: 0
            }
        });
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
