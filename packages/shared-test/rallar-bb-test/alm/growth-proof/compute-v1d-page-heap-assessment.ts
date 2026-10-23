import {
    HEAP_MAX_PLATEAU_FACTOR,
    HEAP_SLOPE_LIMIT_BYTES_PER_HOUR,
    HEAP_WARM_UP_MS,
    MB
} from './compute-v1d-growth-assessment.ts';
import { toV1dGrowthNoData, type V1dGrowthAssessment, type V1dGrowthOutcome } from './v1d-growth-assessment.ts';
import {
    computeV1dGrowthAgentBucketMedians,
    computeV1dGrowthMax,
    computeV1dGrowthSlopePerHour,
    toV1dGrowthMinutes,
    toV1dGrowthRounded,
    type V1dGrowthAgentReading,
    type V1dGrowthAgentSeries
} from './v1d-growth-series.ts';

const PAGE_HEAP_BUCKET_MS = 5 * 60_000;
const PAGE_HEAP_MIN_BUCKETS = 3;

/** One agent's verdict on the page heap predicate; `severity` orders agents of the same outcome, worst highest. */
interface AgentPageHeapJudgement {
    readonly agentId: string;
    readonly outcome: V1dGrowthOutcome;
    readonly severity: number;
    readonly bucketCount: number;
    readonly assessment: V1dGrowthAssessment;
}

const OUTCOME_RANK: Readonly<Partial<Record<V1dGrowthOutcome, number>>> = { fail: 2, insufficient: 1 };

/**
 * A `heap` surface's browser page heap, which holds the page's product structures and the bounded harness event
 * history together. Every agent that reported a page heap reading is judged on its own series of 5-minute bucket
 * medians after the warm-up, on the same predicate: slope within the hourly limit, and the last bucket under twice
 * the first. An agent with fewer than three complete buckets, none included, is insufficient. The row fails if any
 * agent fails, is insufficient if any agent is and none fails, and passes only when every agent passes; it reports
 * the worst agent's numbers and names it. The raw peak is only reported.
 */
export function computeV1dPageHeapAssessment(readings: readonly V1dGrowthAgentReading[]): V1dGrowthAssessment {
    const bound =
        `page heap (product structures + the bounded black-box event history): each agent's 5-minute bucket ` +
        `medians after ${toV1dGrowthMinutes(HEAP_WARM_UP_MS)} min: slope within ` +
        `±${HEAP_SLOPE_LIMIT_BYTES_PER_HOUR / MB} MB/h; last < ${HEAP_MAX_PLATEAU_FACTOR} × first`;
    const judged = computeV1dGrowthAgentBucketMedians(readings, PAGE_HEAP_BUCKET_MS, HEAP_WARM_UP_MS)
        .map((agent) => judgeAgentPageHeap(agent, bound));
    const worst = judged.reduce<AgentPageHeapJudgement | undefined>(
        (current, next) => (current === undefined || isWorse(next, current) ? next : current),
        undefined
    );
    if (worst === undefined) {
        return toV1dGrowthNoData(bound);
    }
    const max = computeV1dGrowthMax(readings.filter((reading) => reading.elapsedMs >= HEAP_WARM_UP_MS));
    return {
        ...worst.assessment,
        max,
        reason: worst.outcome === 'insufficient'
            ? toInsufficientReason(judged.filter((agent) => agent.outcome === 'insufficient'), judged.length)
            : `agent ${worst.agentId} (worst of ${judged.length}): ${worst.assessment.reason}; ` +
                `raw peak ${toV1dGrowthRounded((max ?? 0) / MB)} MB, not judged`
    };
}

function toInsufficientReason(insufficient: readonly AgentPageHeapJudgement[], agentCount: number): string {
    const named = insufficient.map((agent) => `${agent.agentId} (${agent.bucketCount})`).join(', ');
    return `${insufficient.length} of ${agentCount} agents have fewer than ${PAGE_HEAP_MIN_BUCKETS} complete ` +
        `5-minute buckets after the warm-up: ${named}; the page heap check needs ${PAGE_HEAP_MIN_BUCKETS} complete ` +
        `5-minute buckets`;
}

function isWorse(next: AgentPageHeapJudgement, current: AgentPageHeapJudgement): boolean {
    const rankDifference = (OUTCOME_RANK[next.outcome] ?? 0) - (OUTCOME_RANK[current.outcome] ?? 0);
    return rankDifference === 0 ? next.severity > current.severity : rankDifference > 0;
}

function judgeAgentPageHeap(agent: V1dGrowthAgentSeries, bound: string): AgentPageHeapJudgement {
    const { agentId, series } = agent;
    const first = series[0];
    const last = series[series.length - 1];
    const slopePerHour = computeV1dGrowthSlopePerHour(series, 0);
    if (series.length < PAGE_HEAP_MIN_BUCKETS || first === undefined || last === undefined || slopePerHour === null) {
        return toInsufficientJudgement(agent, bound);
    }
    const slopeShare = Math.abs(slopePerHour) / HEAP_SLOPE_LIMIT_BYTES_PER_HOUR;
    const growthShare = first.value === 0 ? 0 : last.value / (HEAP_MAX_PLATEAU_FACTOR * first.value);
    const flat = slopeShare <= 1;
    const belowDouble = last.value < HEAP_MAX_PLATEAU_FACTOR * first.value;
    const outcome = flat && belowDouble ? 'pass' : 'fail';
    return {
        agentId,
        outcome,
        severity: Math.max(slopeShare, growthShare),
        bucketCount: series.length,
        assessment: {
            bound,
            firstPlateau: { atElapsedMs: first.elapsedMs, value: first.value },
            slopePerHour,
            max: null,
            outcome,
            reason:
                `bucket median slope ${toV1dGrowthRounded(slopePerHour / MB)} MB/h${
                    flat ? '' : ' exceeds the limit'
                }; ` +
                `last bucket median ${toV1dGrowthRounded(last.value / MB)} MB against the first ` +
                `${toV1dGrowthRounded(first.value / MB)} MB${belowDouble ? '' : ', twice it or more'}`
        }
    };
}

function toInsufficientJudgement(agent: V1dGrowthAgentSeries, bound: string): AgentPageHeapJudgement {
    const first = agent.series[0];
    return {
        agentId: agent.agentId,
        outcome: 'insufficient',
        severity: -agent.series.length,
        bucketCount: agent.series.length,
        assessment: {
            bound,
            firstPlateau: first === undefined ? null : { atElapsedMs: first.elapsedMs, value: first.value },
            slopePerHour: computeV1dGrowthSlopePerHour(agent.series, 0),
            max: null,
            outcome: 'insufficient',
            reason: `${agent.series.length} complete 5-minute buckets after the warm-up`
        }
    };
}
