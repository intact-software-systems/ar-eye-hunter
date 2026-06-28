import { describe, expect, it } from 'vitest';
import {
    createRallarBlackBoxRtcRealtimeStabilityRecipe,
    createRallarBlackBoxRtcRealtimeRecipe,
    createRallarBlackBoxRtcSmokeRecipe,
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
    RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID,
} from '../../../packages/shared-test/rallar-bb-test/recipe-fixtures.ts';
import {
    RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
    validateJsonSchema,
} from '../../../packages/shared-test/rallar-bb-test/schema.ts';

describe('rallar-bb-test recipe fixtures', () => {
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
