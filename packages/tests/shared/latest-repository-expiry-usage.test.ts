import { describe, expect, it, vi } from 'vitest';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';

// Worked example: the shape RtcRttRefinementService takes when its two hand
// rolled Maps, the read-time expiry helper, the bulk prune and the prune rate
// limiter are all replaced by ExpiringRepository. Kept here rather than in the
// service so the primitive can be judged against a real caller before anything
// migrates.
interface RefinementClaim {
    readonly observationId: string;
    readonly workId: string;
    readonly rttVersion: number;
    readonly expireAtEpochMs: number;
}

class ExampleRefinementService {
    private readonly observations = new LatestRepository<string, number>({
        evictWindowMs: 5_000,
        evictsPerWindow: 2,
    });
    private readonly decisions = new LatestRepository<string, boolean>({
        evictWindowMs: 5_000,
        evictsPerWindow: 2,
    });

    public constructor(
        private readonly nowEpochMs: () => number,
        private readonly observeDelta: (rttVersion: number) => number,
        private readonly claimRefinement: (predictedDeltaMs: number) => boolean,
    ) {}

    public claimWork(input: RefinementClaim): boolean {
        const nowEpochMs = this.nowEpochMs();
        const existing = this.decisions.readAt(input.workId, nowEpochMs);
        if (existing !== undefined) {
            return existing;
        }

        const predictedDeltaMs = this.observations.readOrAcceptAt({
            key: input.observationId,
            value: 0,
            nowEpochMs,
            expireAtEpochMs: input.expireAtEpochMs,
            create: () => this.observeDelta(input.rttVersion),
        });

        const claimed = this.claimRefinement(predictedDeltaMs);
        this.decisions.acceptAt({
            key: input.workId,
            value: claimed,
            nowEpochMs,
            expireAtEpochMs: input.expireAtEpochMs,
        });
        return claimed;
    }

    public readRetainedEntryCounts(): Readonly<{ observations: number; decisions: number }> {
        return {
            observations: this.observations.size(),
            decisions: this.decisions.size(),
        };
    }

    public readEvictionRuns(): number {
        return this.decisions.readEvictionCounts().evictionRuns;
    }
}

describe('LatestRepository as the RTT refinement store', () => {
    it('observes once per durable observation and replays the decision on retry', () => {
        let nowEpochMs = 1_000;
        const observeDelta = vi.fn(() => 4);
        const service = new ExampleRefinementService(
            () => nowEpochMs,
            observeDelta,
            () => true,
        );

        expect(service.claimWork(claim('observation-1', 'work-1'))).toBe(true);
        expect(service.claimWork(claim('observation-1', 'work-1'))).toBe(true);
        expect(observeDelta).toHaveBeenCalledTimes(1);
    });

    // The property the hand-rolled version needed readUnexpiredEntry for: an
    // entry past its deadline must never answer, even while the prune budget
    // for this window is already spent.
    it('re-observes after the deadline instead of replaying a stale decision', () => {
        let nowEpochMs = 1_000;
        const observeDelta = vi.fn(() => 4);
        const service = new ExampleRefinementService(
            () => nowEpochMs,
            observeDelta,
            () => true,
        );

        service.claimWork(claim('observation-1', 'work-1'));
        nowEpochMs = 70_000;
        service.claimWork(claim('observation-1', 'work-1'));

        expect(observeDelta).toHaveBeenCalledTimes(2);
    });

    it('keeps the scan off the per-claim path', () => {
        let nowEpochMs = 1_000;
        const service = new ExampleRefinementService(() => nowEpochMs, () => 4, () => true);

        for (const index of [1, 2, 3, 4, 5, 6]) {
            nowEpochMs = 1_000 + index * 100;
            service.claimWork(claim(`observation-${index}`, `work-${index}`, 200_000));
        }

        expect(service.readRetainedEntryCounts()).toEqual({ observations: 6, decisions: 6 });
        expect(service.readEvictionRuns()).toBe(2);
    });
});

function claim(
    observationId: string,
    workId: string,
    expireAtEpochMs = 60_000,
): RefinementClaim {
    return { observationId, workId, rttVersion: 1, expireAtEpochMs };
}
