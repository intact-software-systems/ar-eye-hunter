export const DISTRIBUTED_ANALYSIS_SNAPSHOT_BOUNDS = {
    commands: 500,
    results: 500,
    events: 1_000,
    stats: 200,
    reports: 120,
    heartbeats: 240
} as const;

export const RUNNER_DISTRIBUTED_POLL_MS = 1_000;
