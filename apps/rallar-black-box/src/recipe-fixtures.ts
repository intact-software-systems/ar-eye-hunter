import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/types.ts';

export {
    createRallarBlackBoxProviderParityLiveRecipe,
    createRallarBlackBoxRtcRealtimeRecipe,
    createRallarBlackBoxRtcRealtimeStabilityRecipe,
    createRallarBlackBoxRtcSmokeRecipe,
    normalizeRallarBlackBoxRtcRealtimeDurationSeconds,
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
    RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS,
    RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
    RALLAR_BLACK_BOX_RTC_REALTIME_MAX_DURATION_SECONDS,
    RALLAR_BLACK_BOX_RTC_REALTIME_MIN_DURATION_SECONDS,
    RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
    RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID,
    recipeFixtureText,
} from '@shared-test/rallar-bb-test/recipe-fixtures.ts';
export type {
    RallarBlackBoxLiveRecipeOptions,
    RallarBlackBoxRecipeFixture,
    RallarBlackBoxRtcRealtimeRecipeOptions,
} from '@shared-test/rallar-bb-test/recipe-fixtures.ts';

export const RALLAR_BLACK_BOX_MANUAL_COMMAND_EXAMPLE: RallarBlackBoxTestCommand = {
    kind: 'rtc.send',
    commandId: 'manual-rtc-send',
    connection: 'aliceRtc',
    transport: 'realtime',
    send: {
        data: {
            topic: 'room.manual.message',
            text: 'hello from manual command',
        },
    },
};
