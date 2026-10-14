export interface FullStackRtcIceFixturePolicy {
    readonly requests: number;
    readonly windowMs: number;
}

export const FULL_STACK_RTC_ICE_FIXTURE_POLICIES = {
    default: { requests: 20, windowMs: 60_000 },
    'all-scenarios': { requests: 20, windowMs: 60_000 },
    'retention-100': { requests: 101, windowMs: 60_000 },
    'combined-all-retention': { requests: 106, windowMs: 60_000 },
    'combined-default-retention': { requests: 103, windowMs: 60_000 }
} as const satisfies Readonly<Record<string, FullStackRtcIceFixturePolicy>>;
