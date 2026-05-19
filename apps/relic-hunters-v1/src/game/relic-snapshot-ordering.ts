import type { RelicPublicSnapshot } from '@relic-hunters/mod.ts';

export type RelicSnapshotSource =
    | 'bootstrap'
    | 'room-hydration'
    | 'timeout-repair'
    | 'rest-command'
    | 'rest-reset'
    | 'rallar-ws'
    | 'rallar-rtc';

export type RelicSnapshotRejectionReason =
    | 'room-mismatch'
    | 'older-updated-at'
    | 'older-round'
    | 'phase-regression'
    | 'less-complete-same-version';

export type RelicSnapshotAcceptance = Readonly<{
    current?: RelicPublicSnapshot;
    candidate: RelicPublicSnapshot;
    expectedRoomId?: string;
    allowSemanticRegression?: boolean;
}>;

export type RelicSnapshotAcceptanceResult = Readonly<
    | { accepted: true }
    | { accepted: false; reason: RelicSnapshotRejectionReason }
>;

export function shouldAcceptRelicSnapshot({
    current,
    candidate,
    expectedRoomId,
    allowSemanticRegression,
}: RelicSnapshotAcceptance): boolean {
    return classifyRelicSnapshotAcceptance({
        current,
        candidate,
        expectedRoomId,
        allowSemanticRegression,
    }).accepted;
}

export function classifyRelicSnapshotAcceptance({
    current,
    candidate,
    expectedRoomId,
    allowSemanticRegression = false,
}: RelicSnapshotAcceptance): RelicSnapshotAcceptanceResult {
    if (expectedRoomId && candidate.roomId !== expectedRoomId) {
        return { accepted: false, reason: 'room-mismatch' };
    }

    if (!current) {
        return { accepted: true };
    }

    if (candidate.gameId !== current.gameId || candidate.roomId !== current.roomId) {
        return { accepted: true };
    }

    if (candidate.updatedAtEpochMs < current.updatedAtEpochMs) {
        return { accepted: false, reason: 'older-updated-at' };
    }

    if (candidate.updatedAtEpochMs > current.updatedAtEpochMs) {
        return { accepted: true };
    }

    if (!allowSemanticRegression && candidate.round < current.round) {
        return { accepted: false, reason: 'older-round' };
    }

    if (candidate.round > current.round || allowSemanticRegression) {
        return { accepted: true };
    }

    const phaseComparison = phaseRank(candidate.phase) - phaseRank(current.phase);
    if (phaseComparison < 0) {
        return { accepted: false, reason: 'phase-regression' };
    }

    if (phaseComparison > 0) {
        return { accepted: true };
    }

    if (isLessCompleteSnapshot(candidate, current)) {
        return { accepted: false, reason: 'less-complete-same-version' };
    }

    return { accepted: true };
}

function phaseRank(phase: RelicPublicSnapshot['phase']): number {
    switch (phase) {
        case 'lobby':
            return 0;
        case 'planning':
            return 1;
        case 'review':
            return 2;
        case 'finished':
            return 3;
    }
}

function isLessCompleteSnapshot(
    candidate: RelicPublicSnapshot,
    current: RelicPublicSnapshot,
): boolean {
    return candidate.events.length < current.events.length ||
        candidate.submittedPlayerIds.length < current.submittedPlayerIds.length ||
        candidate.roomInvestigations.length < current.roomInvestigations.length;
}
