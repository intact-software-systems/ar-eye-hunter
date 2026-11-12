import { describe, expect, it } from 'vitest';
import {
    computeRtcEstablishAndReadyCommandTimeoutMs,
    RALLAR_BLACK_BOX_ENSURE_GROUP_TIMEOUT_MS,
    RALLAR_BLACK_BOX_RTC_READINESS_TIMEOUT_MS
} from '../../../packages/shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts';
import { createRallarBlackBoxRtcSmokeRecipe } from '../../../packages/shared-test/rallar-bb-test/fixtures/rtc-live-recipes.ts';
import {
    computeRtcMessagesDeliveryPollWindowMs,
    computeRtcMessagesRelayHoldMs,
    createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe,
    createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes,
    RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_MULTICAST_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_RECEIVER_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID
} from '../../../packages/shared-test/rallar-bb-test/fixtures/rtc-multicast-recipes.ts';
import {
    createRallarBlackBoxRtcRealtimeRecipe,
    createRallarBlackBoxRtcRealtimeStabilityRecipe,
    RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID
} from '../../../packages/shared-test/rallar-bb-test/fixtures/rtc-realtime-recipes.ts';
import type {
    RallarBlackBoxTestLoopCommand,
    RallarBlackBoxTestRtcConnectCommand
} from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_RECIPE_FIXTURES } from '../../../packages/shared-test/rallar-bb-test/recipe-fixtures.ts';
import { API_MUTATION_COMPLETION_WAIT_MAX_ELAPSED_MS } from '../../../packages/shared/api/mutation/api-mutation-completion-wait-max-elapsed-ms.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '../../shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

const EXPECTED_MESSAGES_RTC_MULTICAST_SELECTOR = {
    typeId: 'black-box.group.multicast.position',
    topicId: 'black-box.group.multicast.position'
} as const;

describe('rallar-bb-test recipe fixtures', () => {
    it('makes RTC group setup explicit and fails unexpected HTTP statuses', () => {
        const recipe = createRallarBlackBoxRtcSmokeRecipe();
        const setup = recipe.commands.filter((command) => command.kind === 'http.request');

        expect(setup[0]).toMatchObject({
            timeoutMs: RALLAR_BLACK_BOX_ENSURE_GROUP_TIMEOUT_MS,
            request: {
                body: { kind: 'room' }
            },
            response: {
                acceptedStatusCodes: [200, 201, 409]
            }
        });
        expect(setup[1]).toMatchObject({
            timeoutMs: RALLAR_BLACK_BOX_ENSURE_GROUP_TIMEOUT_MS,
            response: {
                acceptedStatusCodes: [200, 201]
            }
        });
    });

    it('gives each ensure command a budget that outlasts the server\'s mutation completion wait', () => {
        expect(RALLAR_BLACK_BOX_ENSURE_GROUP_TIMEOUT_MS).toBeGreaterThan(API_MUTATION_COMPLETION_WAIT_MAX_ELAPSED_MS);
    });

    it('builds principal messages.rtc multicast sender and receiver recipes for 50-agent runs', () => {
        const [sender, receiver] = createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes({
            participantCount: 50,
            durationSeconds: 30,
            rateHz: 20,
            minReceiveRatio: 0.95,
            readyTimeoutMs: 45_000
        });
        const senderConnect = sender.commands.find((command) => command.kind === 'rtc.connect');
        const senderConnectIndex = sender.commands.findIndex((command) => command.kind === 'rtc.connect');
        const senderWarmup = sender.commands.find((command) => command.commandId === 'rtc-messages-principal-sender-warmup-stats-loop');
        const senderWarmupIndex = sender.commands.findIndex((command) => command.commandId === 'rtc-messages-principal-sender-warmup-stats-loop');
        const senderStream = sender.commands.find((command) => command.kind === 'rtc.stream');
        const senderStreamIndex = sender.commands.findIndex((command) => command.kind === 'rtc.stream');
        const receiverConnect = receiver.commands.find((command) => command.kind === 'rtc.connect');
        const receiverStats = receiver.commands.find((command) => command.commandId === 'rtc-messages-principal-receiver-final-stats');

        expect(sender.recipeId).toBe(RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID);
        expect(receiver.recipeId).toBe(RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_RECEIVER_RECIPE_FIXTURE_ID);
        expect(sender.metadata).toMatchObject({
            profile: 'rtc-messages-principal-multicast-sender',
            transport: 'messages.rtc',
            participantCount: 50,
            senderCount: 1,
            receiverCount: 49,
            rateHz: 20,
            durationSeconds: 30,
            frameCount: 600
        });
        expect(senderConnect).toMatchObject({
            timeoutMs: computeRtcEstablishAndReadyCommandTimeoutMs(RALLAR_BLACK_BOX_RTC_READINESS_TIMEOUT_MS),
            readiness: { timeoutMs: RALLAR_BLACK_BOX_RTC_READINESS_TIMEOUT_MS }
        });
        expect(computeRtcEstablishAndReadyCommandTimeoutMs(45_000)).toBe(95_000);
        expect(sender.metadata?.expectedInboundMessages).toBeUndefined();
        expect(sender.metadata?.minExpectedInboundMessages).toBeUndefined();
        expect(receiver.metadata).toMatchObject({
            profile: 'rtc-messages-principal-multicast-receiver',
            transport: 'messages.rtc',
            participantCount: 50,
            senderCount: 1,
            receiverCount: 49,
            expectedInboundMessages: 600,
            minExpectedInboundMessages: 570
        });
        expect(senderConnect).toMatchObject({
            kind: 'rtc.connect',
            transport: 'messages.rtc',
            rallar: EXPECTED_MESSAGES_RTC_MULTICAST_SELECTOR,
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 45_000,
                intervalMs: 100
            }
        });
        expect(senderWarmupIndex).toBeGreaterThan(senderConnectIndex);
        expect(senderWarmupIndex).toBeLessThan(senderStreamIndex);
        expect(senderWarmup).toMatchObject({
            kind: 'loop',
            count: 6,
            intervalMs: 1_000,
            maxCommands: 6,
            metadata: {
                purpose: 'post-connect-receiver-settle',
                warmupDurationMs: 5_000
            },
            commands: [{
                kind: 'stats',
                commandId: 'rtc-messages-principal-sender-warmup-stats'
            }]
        });
        expect(senderStream).toMatchObject({
            kind: 'rtc.stream',
            commandId: 'rtc-messages-principal-multicast-stream',
            transport: 'messages.rtc',
            count: 600,
            intervalMs: 50,
            maxInFlight: 64,
            continueOnSendFailure: true,
            send: {
                deliveryMode: 'multicast',
                typeId: 'black-box.group.multicast.position',
                topicId: 'black-box.group.multicast.position',
                payload: {
                    seq: '{stream.index}',
                    totalFrames: 600
                }
            }
        });
        expect(senderStream?.metadata?.receiverDelivery)
            .toBeUndefined();
        expect(receiverConnect).toMatchObject({
            kind: 'rtc.connect',
            transport: 'messages.rtc',
            rallar: EXPECTED_MESSAGES_RTC_MULTICAST_SELECTOR,
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 45_000,
                intervalMs: 100
            }
        });
        expect(receiverStats).toMatchObject({
            kind: 'stats',
            commandId: 'rtc-messages-principal-receiver-final-stats'
        });
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, sender).ok).toBe(true);
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, receiver).ok).toBe(true);
    });

    it('polls principal receiver delivery until the unchanged threshold holds, for the connect budget plus warmup, stream and tail', () => {
        const [, receiver] = createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes({
            participantCount: 50,
            durationSeconds: 30,
            rateHz: 20,
            minReceiveRatio: 0.95,
            readyTimeoutMs: 45_000
        });
        const poll = receiver.commands.find(
            (command): command is RallarBlackBoxTestLoopCommand => command.commandId === 'rtc-messages-principal-receiver-delivery-poll'
        );
        const windowMs = computeRtcMessagesDeliveryPollWindowMs({
            readinessTimeoutMs: 45_000,
            leadInMs: 5_000,
            durationSeconds: 30
        });

        expect(windowMs).toBe(95_000 + 5_000 + 30_000 + 5_000);
        expect(poll).toMatchObject({
            kind: 'loop',
            until: 'first-success',
            intervalMs: 5_000,
            count: Math.ceil(windowMs / 5_000) + 1,
            maxCommands: (Math.ceil(windowMs / 5_000) + 1) * 2,
            commands: [
                { kind: 'stats', commandId: 'rtc-messages-principal-receiver-stats' },
                {
                    kind: 'assert',
                    commandId: 'rtc-messages-principal-receiver-delivery-threshold',
                    source: 'stats.counters.messages',
                    operator: 'gte',
                    expected: 570
                }
            ]
        });
        const pollIndex = receiver.commands.findIndex(
            (command) => command.commandId === 'rtc-messages-principal-receiver-delivery-poll'
        );
        expect(receiver.commands[pollIndex + 1]).toMatchObject({
            kind: 'loop',
            commandId: 'rtc-messages-principal-receiver-relay-hold',
            intervalMs: 1_000,
            count: 8,
            maxCommands: 8,
            commands: [{ kind: 'stats', commandId: 'rtc-messages-principal-receiver-relay-hold-stats' }]
        });
        expect(receiver.commands[pollIndex + 2]).toMatchObject({
            commandId: 'rtc-messages-principal-receiver-final-stats'
        });
        expect(receiver.commands.filter((command) => command.kind === 'assert')).toEqual([]);
        expect(receiver.commands.find((command) => command.commandId === 'rtc-messages-principal-receiver-stats-loop'))
            .toBeUndefined();
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, receiver).ok).toBe(true);
    });

    it('holds a relay for the most stream any one sender can still have left once its threshold holds, plus the tail', () => {
        const principal = createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes({ participantCount: 50 })[1];
        const principalHold = principal.commands.find((command) => command.commandId === 'rtc-messages-principal-receiver-relay-hold');

        // Manifest 07: one sender, so its 30 unreceived frames (1.5 s at 20 Hz) are all it can have left.
        expect(computeRtcMessagesRelayHoldMs({
            frameCount: 600,
            intervalMs: 50,
            expectedInboundMessages: 600,
            minExpectedInboundMessages: 570,
            latestSenderStreamEndMs: 130_000,
            earliestPollStartMs: 0
        })).toBe(1_500 + 5_000);
        expect(principalHold).toMatchObject({ metadata: { purpose: 'relay-hold', relayHoldMs: 6_500 }, count: 8 });
        // Manifest 09: the 735-message shortfall exceeds one sender's 150 frames, so a sender may not have started when
        // the receiver's poll starts 35 s after its connect; that sender streams until the 95 s connect spread, the 5 s
        // settle and the 30 s stream have passed.
        expect(computeRtcMessagesRelayHoldMs({
            frameCount: 150,
            intervalMs: 200,
            expectedInboundMessages: 7_350,
            minExpectedInboundMessages: 6_615,
            latestSenderStreamEndMs: 95_000 + 5_000 + 30_000,
            earliestPollStartMs: 5_000 + 30_000
        })).toBe(95_000 + 5_000);
    });

    it('paces the principal delivery poll at the mid-stream stats interval and stays inside the command limits for long runs', () => {
        const [, receiver] = createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes({
            participantCount: 15,
            durationSeconds: 4_680,
            rateHz: 2,
            minReceiveRatio: 0.95,
            readyTimeoutMs: 45_000,
            midStreamStatsIntervalMs: 30_000
        });
        const poll = receiver.commands.find(
            (command): command is RallarBlackBoxTestLoopCommand => command.commandId === 'rtc-messages-principal-receiver-delivery-poll'
        );

        expect(poll).toMatchObject({ until: 'first-success', intervalMs: 30_000, count: 161, maxCommands: 322 });
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, receiver).ok).toBe(true);
    });

    it('builds all-peer messages.rtc multicast recipes with computed receiver thresholds', () => {
        const recipe = createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe({
            participantCount: 50,
            durationSeconds: 30,
            rateHz: 5,
            minReceiveRatio: 0.9,
            readyTimeoutMs: 45_000
        });
        const connect = recipe.commands.find((command) => command.kind === 'rtc.connect');
        const connectIndex = recipe.commands.findIndex((command) => command.kind === 'rtc.connect');
        const settleLoop = recipe.commands.find(
            (command): command is RallarBlackBoxTestLoopCommand => command.commandId === 'rtc-messages-all-peer-settle-stats-loop'
        );
        const settleLoopIndex = recipe.commands.findIndex((command) => command.commandId === 'rtc-messages-all-peer-settle-stats-loop');
        const stream = recipe.commands.find((command) => command.kind === 'rtc.stream');
        const streamIndex = recipe.commands.findIndex((command) => command.kind === 'rtc.stream');
        const finalStats = recipe.commands.find((command) => command.commandId === 'rtc-messages-all-peer-final-stats');
        const deliveryPoll = recipe.commands.find(
            (command): command is RallarBlackBoxTestLoopCommand => command.commandId === 'rtc-messages-all-peer-delivery-poll'
        );
        const pollWindowMs = computeRtcMessagesDeliveryPollWindowMs({
            readinessTimeoutMs: 45_000,
            leadInMs: 5_000,
            durationSeconds: 30
        });

        expect(recipe.recipeId).toBe(RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_MULTICAST_RECIPE_FIXTURE_ID);
        expect(recipe.metadata).toMatchObject({
            profile: 'rtc-messages-all-peer-multicast',
            transport: 'messages.rtc',
            participantCount: 50,
            senderCount: 50,
            receiverCount: 50,
            rateHz: 5,
            durationSeconds: 30,
            frameCount: 150,
            expectedInboundMessages: 7350,
            minExpectedInboundMessages: 6615,
            logicalFanoutMessages: 367500
        });
        expect(connect).toMatchObject({
            kind: 'rtc.connect',
            transport: 'messages.rtc',
            rallar: EXPECTED_MESSAGES_RTC_MULTICAST_SELECTOR,
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 45_000,
                intervalMs: 100
            }
        });
        expect(settleLoopIndex).toBeGreaterThan(connectIndex);
        expect(settleLoopIndex).toBeLessThan(streamIndex);
        expect(settleLoop).toMatchObject({
            kind: 'loop',
            count: 6,
            intervalMs: 1_000,
            maxCommands: 6,
            metadata: {
                purpose: 'post-connect-topology-settle',
                settleDurationMs: 5_000
            },
            commands: [{
                kind: 'stats',
                commandId: 'rtc-messages-all-peer-settle-stats'
            }]
        });
        expect(settleLoop?.metadata?.expectedInboundMessages).toBeUndefined();
        expect(settleLoop?.metadata?.minExpectedInboundMessages).toBeUndefined();
        expect(settleLoop?.metadata?.minReceiveRatio).toBeUndefined();
        expect(settleLoop?.commands?.[0]?.metadata?.expectedInboundMessages).toBeUndefined();
        expect(settleLoop?.commands?.[0]?.metadata?.minExpectedInboundMessages).toBeUndefined();
        expect(settleLoop?.commands?.[0]?.metadata?.minReceiveRatio).toBeUndefined();
        expect(stream).toMatchObject({
            kind: 'rtc.stream',
            commandId: 'rtc-messages-all-peer-multicast-stream',
            transport: 'messages.rtc',
            count: 150,
            intervalMs: 200,
            maxInFlight: 64,
            continueOnSendFailure: true,
            metadata: {
                receiverDelivery: {
                    expectedInboundMessages: 7350,
                    minExpectedInboundMessages: 6615
                }
            }
        });
        expect(finalStats).toMatchObject({
            kind: 'stats',
            commandId: 'rtc-messages-all-peer-final-stats'
        });
        expect(pollWindowMs).toBe(135_000);
        const allPeerPollIndex = recipe.commands.findIndex(
            (command) => command.commandId === 'rtc-messages-all-peer-delivery-poll'
        );
        expect(recipe.commands[allPeerPollIndex + 1]).toMatchObject({
            kind: 'loop',
            commandId: 'rtc-messages-all-peer-relay-hold',
            intervalMs: 1_000,
            count: 101,
            maxCommands: 101,
            metadata: { purpose: 'relay-hold', relayHoldMs: 100_000 },
            commands: [{ kind: 'stats', commandId: 'rtc-messages-all-peer-relay-hold-stats' }]
        });
        expect(recipe.commands[allPeerPollIndex + 2]).toMatchObject({
            commandId: 'rtc-messages-all-peer-final-stats'
        });
        expect(recipe.commands.filter((command) => command.kind === 'assert')).toEqual([]);
        expect(recipe.commands.find((command) => command.commandId === 'rtc-messages-all-peer-receiver-stats-loop'))
            .toBeUndefined();
        expect(deliveryPoll).toMatchObject({
            kind: 'loop',
            until: 'first-success',
            intervalMs: 5_000,
            count: Math.ceil(pollWindowMs / 5_000) + 1,
            maxCommands: (Math.ceil(pollWindowMs / 5_000) + 1) * 2,
            commands: [
                { kind: 'stats', commandId: 'rtc-messages-all-peer-receiver-stats' },
                {
                    kind: 'assert',
                    commandId: 'rtc-messages-all-peer-delivery-threshold',
                    source: 'stats.counters.messages',
                    operator: 'gte',
                    expected: 6615
                }
            ]
        });
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe).ok).toBe(true);
    });

    it('builds live RTC recipes with optional ready-peer contracts', () => {
        const smoke = createRallarBlackBoxRtcSmokeRecipe({
            readyPeerCount: 1,
            readyTimeoutMs: 10_000
        });
        const connect = smoke.commands.find((command) => command.kind === 'rtc.connect');

        expect(connect).toMatchObject({
            kind: 'rtc.connect',
            timeoutMs: 15_000,
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 10_000,
                intervalMs: 100
            }
        });
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, smoke).ok).toBe(true);
    });

    it('keeps default local fixtures flexible without forced readiness', () => {
        const realtime = createRallarBlackBoxRtcRealtimeRecipe();
        const connect = realtime.commands.find(
            (command): command is RallarBlackBoxTestRtcConnectCommand => command.kind === 'rtc.connect'
        );
        const stream = createRallarBlackBoxRtcRealtimeRecipe({ executionMode: 'stream' })
            .commands.find((command) => command.kind === 'rtc.stream');

        expect(connect).toMatchObject({ kind: 'rtc.connect' });
        expect(connect?.readiness).toBeUndefined();
        expect(realtime.metadata).toMatchObject({
            rateHz: 20,
            intervalMs: 50,
            frameCount: 100,
            executionMode: 'loop'
        });
        expect(stream).toMatchObject({
            kind: 'rtc.stream',
            count: 100,
            intervalMs: 50,
            thresholds: {
                minSendSuccessRatio: 0.99,
                maxDroppedFrames: 0
            }
        });
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, realtime).ok).toBe(true);
    });

    it('builds a lower-risk RTC realtime stability fixture for green runs', () => {
        const recipe = createRallarBlackBoxRtcRealtimeStabilityRecipe({
            readyPeerCount: 1,
            readyTimeoutMs: 10_000
        });
        const connect = recipe.commands.find((command) => command.kind === 'rtc.connect');
        const stream = recipe.commands.find((command) => command.kind === 'rtc.stream');

        expect(recipe.recipeId).toBe(RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID);
        expect(recipe.name).toBe('RTC realtime stability stream');
        expect(recipe.metadata).toMatchObject({
            profile: 'rtc-realtime-stability',
            rateHz: 5,
            intervalMs: 200,
            durationSeconds: 5,
            frameCount: 25,
            executionMode: 'stream'
        });
        expect(connect).toMatchObject({
            kind: 'rtc.connect',
            timeoutMs: 15_000,
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 10_000,
                intervalMs: 100
            }
        });
        expect(stream).toMatchObject({
            kind: 'rtc.stream',
            commandId: 'rtc-realtime-position-stream',
            count: 25,
            intervalMs: 200,
            maxInFlight: 8,
            continueOnSendFailure: true,
            thresholds: {
                minSendSuccessRatio: 0.95,
                maxDroppedFrames: 2
            },
            metadata: {
                realtime: {
                    rateHz: 5,
                    frameCount: 25,
                    executionMode: 'stream'
                }
            }
        });
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe).ok).toBe(true);
    });

    it('allows realtime stream success ratio overrides without changing defaults', () => {
        const recipe = createRallarBlackBoxRtcRealtimeRecipe({
            executionMode: 'stream',
            stream: {
                minSendSuccessRatio: 0.9,
                maxDroppedFrames: 4,
                maxP95SendDurationMs: 200,
                maxP99SendDurationMs: 1000
            }
        });
        const stream = recipe.commands.find((command) => command.kind === 'rtc.stream');
        const defaultRecipe = createRallarBlackBoxRtcRealtimeRecipe({ executionMode: 'stream' });
        const defaultStream = defaultRecipe.commands.find((command) => command.kind === 'rtc.stream');

        expect(stream).toMatchObject({
            kind: 'rtc.stream',
            thresholds: {
                minSendSuccessRatio: 0.9,
                maxDroppedFrames: 4,
                maxP95SendDurationMs: 200,
                maxP99SendDurationMs: 1000
            }
        });
        expect(defaultStream).toMatchObject({
            kind: 'rtc.stream',
            thresholds: {
                minSendSuccessRatio: 0.99,
                maxDroppedFrames: 0
            }
        });
    });

    it('exports a stable fixture catalog for SPA and manifest generation', () => {
        expect(RALLAR_BLACK_BOX_RECIPE_FIXTURES.map((fixture) => fixture.fixtureId)).toContain('composite-evidence');
        expect(RALLAR_BLACK_BOX_RECIPE_FIXTURES.map((fixture) => fixture.fixtureId)).toContain('expected-failure');
        expect(RALLAR_BLACK_BOX_RECIPE_FIXTURES.map((fixture) => fixture.fixtureId)).toContain(
            RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID
        );
    });
});
