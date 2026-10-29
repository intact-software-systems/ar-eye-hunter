import type { RelicPublicSnapshot } from '@relic-hunters/mod.ts';
import { startRepeating } from '@shared/resilience/start-repeating.ts';
import type { Timers } from '@shared/resilience/timers.ts';

interface RelicRoundRepair {
    readonly key: string;
    readonly deadlineEpochMs: number;
}

export namespace RelicRoundDeadlineRepair {
    export interface Dependencies {
        readonly timers: Timers;
        refresh(): Promise<void>;
    }
    export interface Config {
        readonly intervalMs: number;
    }
}

/** Owns the deadline and retry timers used to recover missing authoritative round transitions. */
export class RelicRoundDeadlineRepair {
    private readonly dependencies: RelicRoundDeadlineRepair.Dependencies;
    private readonly config: RelicRoundDeadlineRepair.Config;
    private cancelDeadline: (() => void) | undefined;
    private stopRepeating: (() => void) | undefined;
    private key = '';

    constructor(dependencies: RelicRoundDeadlineRepair.Dependencies, config: RelicRoundDeadlineRepair.Config) {
        this.dependencies = dependencies;
        this.config = config;
    }

    observe(snapshot: RelicPublicSnapshot): void {
        const repair = timedOutRoundRepair(snapshot);
        if (repair?.key === this.key) {
            return;
        }
        this.clear();
        if (!repair) {
            return;
        }
        this.key = repair.key;
        this.cancelDeadline = this.dependencies.timers.schedule(
            () => this.start(),
            Math.max(0, repair.deadlineEpochMs - this.dependencies.timers.nowMs())
        );
    }

    clear(): void {
        this.cancelDeadline?.();
        this.stopRepeating?.();
        this.cancelDeadline = undefined;
        this.stopRepeating = undefined;
        this.key = '';
    }

    private start(): void {
        this.stopRepeating = startRepeating({
            timers: this.dependencies.timers,
            intervalMs: this.config.intervalMs,
            firstRun: 'now',
            run: () => this.dependencies.refresh()
        });
    }
}

function timedOutRoundRepair(snapshot: RelicPublicSnapshot): RelicRoundRepair | undefined {
    if (snapshot.phase !== 'planning' || snapshot.roundStartedAtEpochMs === undefined) {
        return undefined;
    }
    const active = snapshot.players.filter((player) => !player.escaped && !player.defeated).length;
    const submitted = snapshot.submittedPlayerIds.length;
    if (active === 0 || submitted >= active) {
        return undefined;
    }
    const deadlineEpochMs = snapshot.roundStartedAtEpochMs + snapshot.roundTimeLimitMs;
    return {
        key: [snapshot.roomId, snapshot.createdAtEpochMs, snapshot.round, deadlineEpochMs, active, submitted].join(':'),
        deadlineEpochMs
    };
}
