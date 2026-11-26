import type { ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import type { ALOutboundDequeuedAdmission } from './al-outbound-dequeued-admission.ts';

type ALOutboundAdmissionGroupObservation = Extract<
    ALOutboundDequeuedAdmission.TimingObservation,
    { kind: 'admission-group'; }
>;

/**
 * One group commit as its `admission-group` timing states it, before its durations are computed. Each fence group of
 * one batch carries the whole batch's read window, so a sum of a mixed batch's durations counts that read twice. The
 * sender-fenced members left out because their versions disagree commit alone and appear in no group's timing.
 */
export interface ALOutboundAdmissionGroupTiming {
    readonly lane: ALOutboundAdmissionGroupObservation['lane'];
    /** The claimed row of the group's first member; a group with none records nothing. */
    readonly entry: ResourceEntry | undefined;
    readonly memberCount: number;
    readonly startedAtMs: number;
    /** When the group's decisions were read; `undefined` when that read threw. */
    readonly decisionEndedAtMs: number | undefined;
    readonly endedAtMs: number;
    readonly outcome: ALOutboundAdmissionGroupObservation['outcome'];
}

/** The optional timing sink cannot alter dequeue or release behavior. */
export function recordALOutboundDequeueTiming(
    sink: ALOutboundDequeuedAdmission.TimingSink | undefined,
    observation: ALOutboundDequeuedAdmission.TimingObservation
): void {
    try {
        sink?.(observation);
    }
    catch {
        // Optional timing must not affect the queue attempt.
    }
}

/** The `admission-group` observation of one group commit: its decision window, then its write's. */
export function recordALOutboundAdmissionGroupTiming(
    sink: ALOutboundDequeuedAdmission.TimingSink | undefined,
    timing: ALOutboundAdmissionGroupTiming
): void {
    const { lane, entry, memberCount, startedAtMs, decisionEndedAtMs, endedAtMs, outcome } = timing;
    if (sink === undefined || entry === undefined) {
        return;
    }
    recordALOutboundDequeueTiming(sink, {
        kind: 'admission-group',
        lane,
        entry,
        memberCount,
        startedAtMs,
        decisionDurationMs: Math.max(0, (decisionEndedAtMs ?? endedAtMs) - startedAtMs),
        bundleDurationMs: decisionEndedAtMs === undefined || outcome === 'not-attempted'
            ? 0
            : Math.max(0, endedAtMs - decisionEndedAtMs),
        outcome
    });
}
