import { MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_CATALOG_ENTRIES } from '../distributed-artifact-evidence-contracts.ts';
import { compareEvidenceEntries } from './compare-evidence-entries.ts';
import type { CatalogCandidate } from './resolve-distinct-catalog-candidates.ts';
import { resolvePrimaryDistributedArtifactResultFailure } from './resolve-primary-distributed-artifact-result-failure.ts';

/** The candidates a full catalog keeps before its newest entries; each is undefined when the artifact has none. */
export interface CatalogAnchors {
    readonly primaryFailure: CatalogCandidate | undefined;
    readonly latestDiagnostic: CatalogCandidate | undefined;
    readonly primaryResultFailure: CatalogCandidate | undefined;
}

/** The anchors first, then the newest candidates, up to the catalog limit; returned in evidence order. */
export function computeRetainedCatalogCandidates(
    newestCandidates: readonly CatalogCandidate[],
    anchors: CatalogAnchors
): CatalogCandidate[] {
    const retained: CatalogCandidate[] = [];
    const retainedIds = new Set<string>();
    const newest = [...newestCandidates].sort(compareNewestCandidates);
    for (
        const candidate of [anchors.primaryFailure, anchors.latestDiagnostic, anchors.primaryResultFailure, ...newest]
    ) {
        if (retained.length >= MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_CATALOG_ENTRIES) {
            break;
        }
        if (candidate && !retainedIds.has(candidate.entry.id)) {
            retained.push(candidate);
            retainedIds.add(candidate.entry.id);
        }
    }
    return retained.sort((left, right) => compareEvidenceEntries(left.entry, right.entry));
}

/**
 * Selects anchors as candidates arrive. The primary failure is the earliest analysis failure, else the latest other
 * failure seen before any analysis failure; the primary result failure follows the evidence index's rule.
 */
export class CatalogAnchorSelection {
    readonly #failureCommandId: string | undefined;

    #primaryAnalysisFailure: CatalogCandidate | undefined;

    #latestFallbackFailure: CatalogCandidate | undefined;

    #latestDiagnostic: CatalogCandidate | undefined;

    #primaryResultFailure: CatalogCandidate | undefined;

    /** The failing command is undefined when the analysis passed or names none. */
    constructor(failureCommandId: string | undefined) {
        this.#failureCommandId = failureCommandId;
    }

    add(candidate: CatalogCandidate): void {
        const { entry } = candidate;
        if (entry.id.startsWith('failure:analysis:')) {
            const primary = this.#primaryAnalysisFailure;
            this.#primaryAnalysisFailure = !primary || compareEvidenceEntries(entry, primary.entry) < 0
                ? candidate
                : primary;
            this.#latestFallbackFailure = undefined;
        }
        else if (entry.kind === 'failure' && !this.#primaryAnalysisFailure) {
            this.#latestFallbackFailure = resolveNewerCandidate(this.#latestFallbackFailure, candidate);
        }
        if (entry.kind === 'diagnostic') {
            this.#latestDiagnostic = resolveNewerCandidate(this.#latestDiagnostic, candidate);
        }
        const primaryResultFailure = resolvePrimaryDistributedArtifactResultFailure(
            this.#primaryResultFailure ? [this.#primaryResultFailure.entry, entry] : [entry],
            this.#failureCommandId
        );
        if (primaryResultFailure === entry) {
            this.#primaryResultFailure = candidate;
        }
    }

    toAnchors(): CatalogAnchors {
        return {
            primaryFailure: this.#primaryAnalysisFailure ?? this.#latestFallbackFailure,
            latestDiagnostic: this.#latestDiagnostic,
            primaryResultFailure: this.#primaryResultFailure
        };
    }
}

/** A min-heap on retention order that keeps the newest candidates up to its limit. */
export class BoundedNewestCandidates {
    readonly #heap: CatalogCandidate[] = [];

    readonly #limit: number;

    constructor(limit: number) {
        this.#limit = limit;
    }

    add(candidate: CatalogCandidate): void {
        if (this.#limit === 0) {
            return;
        }
        if (this.#heap.length < this.#limit) {
            this.#heap.push(candidate);
            this.#bubbleUp(this.#heap.length - 1);
            return;
        }
        const evicted = this.#heap[0];
        if (!evicted || compareCandidateRetention(candidate, evicted) <= 0) {
            return;
        }
        this.#heap[0] = candidate;
        this.#siftDown(0);
    }

    getCandidates(): readonly CatalogCandidate[] {
        return this.#heap;
    }

    #bubbleUp(start: number): void {
        let index = start;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            const parentValue = this.#heap[parent];
            const value = this.#heap[index];
            if (!parentValue || !value || compareCandidateRetention(value, parentValue) >= 0) {
                break;
            }
            this.#heap[parent] = value;
            this.#heap[index] = parentValue;
            index = parent;
        }
    }

    #siftDown(start: number): void {
        let index = start;
        let next = this.#resolveEvictedChild(index);
        while (next !== index) {
            const value = this.#heap[index];
            const replacement = this.#heap[next];
            if (!value || !replacement) {
                return;
            }
            this.#heap[index] = replacement;
            this.#heap[next] = value;
            index = next;
            next = this.#resolveEvictedChild(index);
        }
    }

    /** The index among a node and its children whose candidate the heap evicts first. */
    #resolveEvictedChild(index: number): number {
        let evicted = index;
        for (const child of [index * 2 + 1, index * 2 + 2]) {
            const childValue = this.#heap[child];
            const evictedValue = this.#heap[evicted];
            if (childValue && evictedValue && compareCandidateRetention(childValue, evictedValue) < 0) {
                evicted = child;
            }
        }
        return evicted;
    }
}

function resolveNewerCandidate(current: CatalogCandidate | undefined, candidate: CatalogCandidate): CatalogCandidate {
    return !current || compareNewestCandidates(candidate, current) < 0 ? candidate : current;
}

function compareNewestCandidates(left: CatalogCandidate, right: CatalogCandidate): number {
    return (right.entry.atEpochMs ?? Number.MIN_SAFE_INTEGER) - (left.entry.atEpochMs ?? Number.MIN_SAFE_INTEGER) ||
        compareEvidenceEntries(left.entry, right.entry);
}

/** Orders candidates from the one a full heap evicts first to the one it keeps longest. */
function compareCandidateRetention(left: CatalogCandidate, right: CatalogCandidate): number {
    return (left.entry.atEpochMs ?? Number.MIN_SAFE_INTEGER) - (right.entry.atEpochMs ?? Number.MIN_SAFE_INTEGER) ||
        -compareEvidenceEntries(left.entry, right.entry);
}
