import type { ExplicitWindowModel } from '../ui/explicit-window-model.ts';
import type { AnalyzeEvidenceWindowProjection } from
    './analyze-worker-contract.ts';

/**
 * Adapts the worker's one-based cursor range to the shared explicit-window
 * presentation contract. Cursor presence remains the navigation authority.
 */
export function deriveAnalyzeEvidenceWindowModel(
    window: AnalyzeEvidenceWindowProjection,
    fingerprint: string,
): ExplicitWindowModel {
    const total = nonNegativeInteger(window.counts.retainedMatches);
    const displayStart = window.entries.length === 0
        ? 0
        : positiveInteger(window.rangeStart);
    const displayEnd = window.entries.length === 0
        ? 0
        : Math.min(total, Math.max(displayStart, positiveInteger(window.rangeEnd)));
    const startIndex = displayStart === 0 ? 0 : displayStart - 1;

    return {
        fingerprint,
        total,
        windowSize: positiveInteger(window.windowSize),
        startIndex,
        endIndexExclusive: displayEnd,
        displayStart,
        displayEnd,
        canPrevious: Boolean(window.previousCursor),
        canNext: Boolean(window.nextCursor),
    };
}

function nonNegativeInteger(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function positiveInteger(value: number): number {
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}
