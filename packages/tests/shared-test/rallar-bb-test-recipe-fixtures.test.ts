import { describe, expect, it } from 'vitest';
import {
    createRallarBlackBoxRtcRealtimeRecipe,
    createRallarBlackBoxRtcSmokeRecipe,
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
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

        expect(connect).toMatchObject({ kind: 'rtc.connect' });
        expect((connect as { readiness?: unknown } | undefined)?.readiness).toBeUndefined();
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, realtime).ok).toBe(true);
    });

    it('exports a stable fixture catalog for SPA and manifest generation', () => {
        expect(RALLAR_BLACK_BOX_RECIPE_FIXTURES.map(fixture => fixture.fixtureId)).toContain('composite-evidence');
        expect(RALLAR_BLACK_BOX_RECIPE_FIXTURES.map(fixture => fixture.fixtureId)).toContain('expected-failure');
    });
});
