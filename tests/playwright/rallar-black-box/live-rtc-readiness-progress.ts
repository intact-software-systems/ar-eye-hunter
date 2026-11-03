import {
    isGroupLayoutIdentity,
    isSameGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { Either } from '@shared/resilience/Either.ts';

import { exactStringArray, jsonRecord } from './live-rtc-evidence-json.ts';
import type { FormationDiagnosticEvent } from './live-rtc-formation-operations.ts';

interface ProgressSeriesIssue {
    readonly index: number;
    readonly reason: string;
}

interface ProgressSample {
    readonly desiredCount: number;
    readonly readyCount: number;
    readonly identity: GroupLayoutIdentity | undefined;
    readonly groupRevision: number;
}

/** A write closes a window. Every window is checked, including those interrupted before completion. */
export function validateProgressSeries(
    samples: readonly FormationDiagnosticEvent[],
    windowPolicy: 'single-revision' | 'successive-revisions' = 'single-revision'
): readonly ProgressSeriesIssue[] {
    const issues: ProgressSeriesIssue[] = [];
    let previous: ProgressSample | undefined;
    let hydrated = false;
    for (const [index, event] of samples.entries()) {
        const decoded = decodeProgressSample(event);
        if (decoded.left) {
            issues.push(...decoded.left.map((reason) => ({ index, reason })));
            continue;
        }
        const sample = decoded.right;
        if (!sample) {
            continue;
        }
        if (previous) {
            if (sample.groupRevision < previous.groupRevision) {
                issues.push({ index, reason: 'the group revision moved backwards' });
            }
            if (windowPolicy === 'single-revision' || sample.groupRevision === previous.groupRevision) {
                issues.push(...validateWindowProgress(previous, sample).map((reason) => ({ index, reason })));
            }
        }
        if (sample.desiredCount === 0 && hydrated) {
            issues.push({ index, reason: 'the desired peer set disappeared after hydration' });
        }
        hydrated ||= sample.desiredCount > 0;
        previous = sample;
    }
    if (!hydrated) {
        issues.push({ index: -1, reason: 'no sample carried a desired peer set' });
    }
    else if (previous && previous.desiredCount > 0 && fractionOf(previous) !== 1) {
        issues.push({ index: samples.length - 1, reason: `the window ended at ${fractionOf(previous)}` });
    }
    return issues;
}

function validateWindowProgress(previous: ProgressSample, sample: ProgressSample): readonly string[] {
    const issues: string[] = [];
    if (previous.identity && sample.identity && !isSameGroupLayoutIdentity(sample.identity, previous.identity)) {
        issues.push('the accepted layout changed inside the window');
    }
    if (sample.groupRevision !== previous.groupRevision) {
        issues.push('the group revision moved inside the window');
    }
    if (sample.desiredCount > 0 && previous.desiredCount > 0 && fractionOf(sample) < fractionOf(previous)) {
        issues.push(`the ready fraction fell to ${fractionOf(sample)}`);
    }
    return issues;
}

/** Missing/malformed evidence is an issue; only a valid empty peer set denotes hydration. */
function decodeProgressSample(value: FormationDiagnosticEvent): Either<readonly string[], ProgressSample> {
    const room = jsonRecord(value.data.room);
    if (!room) {
        return Either.ofLeft(['the sample has no valid room']);
    }
    const issues: string[] = [];
    const desired = exactStringArray(room.desiredPeerIds);
    const ready = exactStringArray(room.readyPeerIds);
    const identity =
        isGroupLayoutIdentity(room.acceptedLayoutIdentity) && room.acceptedLayoutIdentity.state === 'active'
            ? room.acceptedLayoutIdentity
            : undefined;
    const revision = value.data.groupRevision;
    if (!desired || new Set(desired).size !== desired.length) {
        issues.push('desired peers must be a unique string set');
    }
    if (!ready || new Set(ready).size !== ready.length || ready.some((peer) => !desired?.includes(peer))) {
        issues.push('ready peers must be a unique subset of desired peers');
    }
    if (desired && desired.length > 0 && !identity) {
        issues.push('desired peers require an active accepted layout identity');
    }
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
        issues.push('the sample has no valid group revision');
    }
    if (issues.length > 0 || !desired || !ready || typeof revision !== 'number') {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({
        desiredCount: desired.length,
        readyCount: ready.length,
        identity,
        groupRevision: revision
    });
}

function fractionOf(sample: ProgressSample): number {
    return sample.readyCount / sample.desiredCount;
}
