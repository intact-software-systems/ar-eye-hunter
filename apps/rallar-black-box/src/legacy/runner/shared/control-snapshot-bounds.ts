export const RUN_MANAGER_SNAPSHOT_BOUNDS = {
    commands: 120,
    results: 120,
    events: 160,
    stats: 60,
    reports: 40,
    heartbeats: 80
} as const;

/** A distributed run monitor links warnings by scanning events, so it reads past the run manager's short tail. */
export const DISTRIBUTED_ANALYSIS_SNAPSHOT_BOUNDS = {
    commands: 500,
    results: 500,
    events: 1_000,
    stats: 200,
    reports: 120,
    heartbeats: 240
} as const;
