import { describe, expect, it } from 'vitest';
import {
    createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe,
    createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes,
    createRallarBlackBoxRtcRealtimeStabilityRecipe,
    createRallarBlackBoxRtcRealtimeRecipe,
    createRallarBlackBoxRtcSmokeRecipe,
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
    RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_MULTICAST_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_RECEIVER_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID,
} from '../../../packages/shared-test/rallar-bb-test/recipe-fixtures.ts';
import {
    RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
    validateJsonSchema,
} from '../../../packages/shared-test/rallar-bb-test/schema.ts';

const EXPECTED_MESSAGES_RTC_MULTICAST_SELECTOR = {
    typeId: 'black-box.group.multicast.position',
    topicId: 'black-box.group.multicast.position',
} as const;

describe('rallar-bb-test recipe fixtures', () => {
    it('makes RTC group setup explicit and fails unexpected HTTP statuses', () => {
        const recipe = createRallarBlackBoxRtcSmokeRecipe();
        const setup = recipe.commands.filter(command => command.kind === 'http.request');

        expect(setup[0]).toMatchObject({
            request: {
                body: { kind: 'room' },
            },
            response: {
                acceptedStatusCodes: [200, 201, 409],
            },
        });
        expect(setup[1]).toMatchObject({
            response: {
                acceptedStatusCodes: [200, 201],
            },
        });
    });

    it('builds principal messages.rtc multicast sender and receiver recipes for 50-agent runs', () => {
        const [sender, receiver] = createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes({
            participantCount: 50,
            durationSeconds: 30,
            rateHz: 20,
            minReceiveRatio: 0.95,
            readyTimeoutMs: 45_000,
        });
        const senderConnect = sender.commands.find(command => command.kind === 'rtc.connect');
        const senderConnectIndex = sender.commands.findIndex(command => command.kind === 'rtc.connect');
        const senderWarmup = sender.commands.find(command =>
            command.commandId === 'rtc-messages-principal-sender-warmup-stats-loop'
        );
        const senderWarmupIndex = sender.commands.findIndex(command =>
            command.commandId === 'rtc-messages-principal-sender-warmup-stats-loop'
        );
        const senderStream = sender.commands.find(command => command.kind === 'rtc.stream');
        const senderStreamIndex = sender.commands.findIndex(command => command.kind === 'rtc.stream');
        const receiverConnect = receiver.commands.find(command => command.kind === 'rtc.connect');
        const receiverStats = receiver.commands.find(command => command.commandId === 'rtc-messages-principal-receiver-final-stats');
        const receiverAssert = receiver.commands.find(command => command.kind === 'assert');

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
            frameCount: 600,
        });
        expect((sender.metadata as Record<string, unknown>).expectedInboundMessages).toBeUndefined();
        expect((sender.metadata as Record<string, unknown>).minExpectedInboundMessages).toBeUndefined();
        expect(receiver.metadata).toMatchObject({
            profile: 'rtc-messages-principal-multicast-receiver',
            transport: 'messages.rtc',
            participantCount: 50,
            senderCount: 1,
            receiverCount: 49,
            expectedInboundMessages: 600,
            minExpectedInboundMessages: 570,
        });
        expect(senderConnect).toMatchObject({
            kind: 'rtc.connect',
            transport: 'messages.rtc',
            rallar: EXPECTED_MESSAGES_RTC_MULTICAST_SELECTOR,
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 45_000,
                intervalMs: 100,
            },
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
                warmupDurationMs: 5_000,
            },
            commands: [{
                kind: 'stats',
                commandId: 'rtc-messages-principal-sender-warmup-stats',
            }],
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
                    totalFrames: 600,
                },
            },
        });
        expect((senderStream as { metadata?: Record<string, unknown> } | undefined)?.metadata?.receiverDelivery)
            .toBeUndefined();
        expect(receiverConnect).toMatchObject({
            kind: 'rtc.connect',
            transport: 'messages.rtc',
            rallar: EXPECTED_MESSAGES_RTC_MULTICAST_SELECTOR,
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 45_000,
                intervalMs: 100,
            },
        });
        expect(receiverStats).toMatchObject({
            kind: 'stats',
            commandId: 'rtc-messages-principal-receiver-final-stats',
        });
        expect(receiverAssert).toMatchObject({
            kind: 'assert',
            source: 'stats.counters.messages',
            operator: 'gte',
            expected: 570,
        });
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, sender).ok).toBe(true);
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, receiver).ok).toBe(true);
    });

    it('uses sparse receiver stats polling for long principal messages.rtc multicast runs', () => {
        const [, receiver] = createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes({
            participantCount: 30,
            durationSeconds: 300,
            rateHz: 20,
            minReceiveRatio: 0.95,
            readyTimeoutMs: 45_000,
        });
        const receiverStatsLoop = receiver.commands.find(command =>
            command.commandId === 'rtc-messages-principal-receiver-stats-loop'
        );

        expect(receiverStatsLoop).toMatchObject({
            kind: 'loop',
            count: 62,
            intervalMs: 5_000,
            maxCommands: 62,
        });
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, receiver).ok).toBe(true);
    });

    it('builds all-peer messages.rtc multicast recipes with computed receiver thresholds', () => {
        const recipe = createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe({
            participantCount: 50,
            durationSeconds: 30,
            rateHz: 5,
            minReceiveRatio: 0.9,
            readyTimeoutMs: 45_000,
        });
        const connect = recipe.commands.find(command => command.kind === 'rtc.connect');
        const connectIndex = recipe.commands.findIndex(command => command.kind === 'rtc.connect');
        const settleLoop = recipe.commands.find(command =>
            command.commandId === 'rtc-messages-all-peer-settle-stats-loop'
        );
        const settleLoopIndex = recipe.commands.findIndex(command =>
            command.commandId === 'rtc-messages-all-peer-settle-stats-loop'
        );
        const stream = recipe.commands.find(command => command.kind === 'rtc.stream');
        const streamIndex = recipe.commands.findIndex(command => command.kind === 'rtc.stream');
        const finalStats = recipe.commands.find(command => command.commandId === 'rtc-messages-all-peer-final-stats');
        const deliveryAssert = recipe.commands.find(command => command.kind === 'assert');

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
            logicalFanoutMessages: 367500,
        });
        expect(connect).toMatchObject({
            kind: 'rtc.connect',
            transport: 'messages.rtc',
            rallar: EXPECTED_MESSAGES_RTC_MULTICAST_SELECTOR,
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 45_000,
                intervalMs: 100,
            },
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
                settleDurationMs: 5_000,
            },
            commands: [{
                kind: 'stats',
                commandId: 'rtc-messages-all-peer-settle-stats',
            }],
        });
        const settleLoopRecord = settleLoop as {
            metadata?: Record<string, unknown>;
            commands?: readonly { metadata?: Record<string, unknown> }[];
        } | undefined;
        expect(settleLoopRecord?.metadata?.expectedInboundMessages).toBeUndefined();
        expect(settleLoopRecord?.metadata?.minExpectedInboundMessages).toBeUndefined();
        expect(settleLoopRecord?.metadata?.minReceiveRatio).toBeUndefined();
        expect(settleLoopRecord?.commands?.[0]?.metadata?.expectedInboundMessages).toBeUndefined();
        expect(settleLoopRecord?.commands?.[0]?.metadata?.minExpectedInboundMessages).toBeUndefined();
        expect(settleLoopRecord?.commands?.[0]?.metadata?.minReceiveRatio).toBeUndefined();
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
                    minExpectedInboundMessages: 6615,
                },
            },
        });
        expect(finalStats).toMatchObject({
            kind: 'stats',
            commandId: 'rtc-messages-all-peer-final-stats',
        });
        expect(deliveryAssert).toMatchObject({
            kind: 'assert',
            source: 'stats.counters.messages',
            operator: 'gte',
            expected: 6615,
        });
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe).ok).toBe(true);
    });

    it('builds live RTC recipes with optional ready-peer contracts', () => {
        const smoke = createRallarBlackBoxRtcSmokeRecipe({
            readyPeerCount: 1,
            readyTimeoutMs: 10_000,
        });
        const connect = smoke.commands.find(command => command.kind === 'rtc.connect');

        expect(connect).toMatchObject({
            kind: 'rtc.connect',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 10_000,
                intervalMs: 100,
            },
        });
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, smoke).ok).toBe(true);
    });

    it('keeps default local fixtures flexible without forced readiness', () => {
        const realtime = createRallarBlackBoxRtcRealtimeRecipe();
        const connect = realtime.commands.find(command => command.kind === 'rtc.connect');
        const stream = createRallarBlackBoxRtcRealtimeRecipe({ executionMode: 'stream' })
            .commands.find(command => command.kind === 'rtc.stream');

        expect(connect).toMatchObject({ kind: 'rtc.connect' });
        expect((connect as { readiness?: unknown } | undefined)?.readiness).toBeUndefined();
        expect(realtime.metadata).toMatchObject({
            rateHz: 20,
            intervalMs: 50,
            frameCount: 100,
            executionMode: 'loop',
        });
        expect(stream).toMatchObject({
            kind: 'rtc.stream',
            count: 100,
            intervalMs: 50,
            thresholds: {
                minSendSuccessRatio: 0.99,
                maxDroppedFrames: 0,
            },
        });
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, realtime).ok).toBe(true);
    });

    it('builds a lower-risk RTC realtime stability fixture for green runs', () => {
        const recipe = createRallarBlackBoxRtcRealtimeStabilityRecipe({
            readyPeerCount: 1,
            readyTimeoutMs: 10_000,
        });
        const connect = recipe.commands.find(command => command.kind === 'rtc.connect');
        const stream = recipe.commands.find(command => command.kind === 'rtc.stream');

        expect(recipe.recipeId).toBe(RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID);
        expect(recipe.name).toBe('RTC realtime stability stream');
        expect(recipe.metadata).toMatchObject({
            profile: 'rtc-realtime-stability',
            rateHz: 5,
            intervalMs: 200,
            durationSeconds: 5,
            frameCount: 25,
            executionMode: 'stream',
        });
        expect(connect).toMatchObject({
            kind: 'rtc.connect',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 10_000,
                intervalMs: 100,
            },
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
                maxDroppedFrames: 2,
            },
            metadata: {
                realtime: {
                    rateHz: 5,
                    frameCount: 25,
                    executionMode: 'stream',
                },
            },
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
                maxP99SendDurationMs: 1000,
            },
        });
        const stream = recipe.commands.find(command => command.kind === 'rtc.stream');
        const defaultRecipe = createRallarBlackBoxRtcRealtimeRecipe({ executionMode: 'stream' });
        const defaultStream = defaultRecipe.commands.find(command => command.kind === 'rtc.stream');

        expect(stream).toMatchObject({
            kind: 'rtc.stream',
            thresholds: {
                minSendSuccessRatio: 0.9,
                maxDroppedFrames: 4,
                maxP95SendDurationMs: 200,
                maxP99SendDurationMs: 1000,
            },
        });
        expect(defaultStream).toMatchObject({
            kind: 'rtc.stream',
            thresholds: {
                minSendSuccessRatio: 0.99,
                maxDroppedFrames: 0,
            },
        });
    });

    it('exports a stable fixture catalog for SPA and manifest generation', () => {
        expect(RALLAR_BLACK_BOX_RECIPE_FIXTURES.map(fixture => fixture.fixtureId)).toContain('composite-evidence');
        expect(RALLAR_BLACK_BOX_RECIPE_FIXTURES.map(fixture => fixture.fixtureId)).toContain('expected-failure');
        expect(RALLAR_BLACK_BOX_RECIPE_FIXTURES.map(fixture => fixture.fixtureId)).toContain(
            RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID,
        );
    });
});
