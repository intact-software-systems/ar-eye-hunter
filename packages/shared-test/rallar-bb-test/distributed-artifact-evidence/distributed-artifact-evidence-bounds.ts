import type {
    DistributedArtifactEvidenceEntry,
    DistributedArtifactEvidenceFailureDetails
} from '../distributed-artifact-evidence-contracts.ts';

const MINIMUM_EVIDENCE_TEXT_LIMIT = 8;

/** A count limit clamped to zero and the maximum; an absent or non-finite limit is the default limit. */
export function resolveEvidenceLimit(limit: number | undefined, defaultLimit: number, maximum: number): number {
    if (limit === undefined || !Number.isFinite(limit)) {
        return defaultLimit;
    }
    return Math.min(maximum, Math.max(0, Math.floor(limit)));
}

/** A text limit clamped to the shortest readable text and the maximum; a non-finite limit is the default limit. */
export function resolveEvidenceTextLimit(limit: number, defaultLimit: number, maximum: number): number {
    if (!Number.isFinite(limit)) {
        return defaultLimit;
    }
    return Math.min(maximum, Math.max(MINIMUM_EVIDENCE_TEXT_LIMIT, Math.floor(limit)));
}

/** Summary texts and failure details collapse their whitespace and end in an ellipsis past their limit. */
export function toBoundedEvidenceEntry(
    entry: DistributedArtifactEvidenceEntry,
    summaryLimit: number,
    payloadSummaryLimit: number
): DistributedArtifactEvidenceEntry {
    return {
        ...entry,
        summary: toBoundedEvidenceText(entry.summary, summaryLimit),
        payloadSummary: toBoundedEvidenceText(entry.payloadSummary, payloadSummaryLimit),
        ...(entry.failureDetails
            ? { failureDetails: toBoundedFailureDetails(entry.failureDetails, summaryLimit, payloadSummaryLimit) }
            : {})
    };
}

/** A stack keeps its lines, since a stack frame per line is what a reader scans. */
function toBoundedFailureDetails(
    details: DistributedArtifactEvidenceFailureDetails,
    summaryLimit: number,
    stackLimit: number
): DistributedArtifactEvidenceFailureDetails {
    return {
        ...(details.code ? { code: toBoundedEvidenceText(details.code, summaryLimit) } : {}),
        ...(details.name ? { name: toBoundedEvidenceText(details.name, summaryLimit) } : {}),
        ...(details.message ? { message: toBoundedEvidenceText(details.message, summaryLimit) } : {}),
        ...(details.stack ? { stack: toBoundedMultilineEvidenceText(details.stack, stackLimit) } : {})
    };
}

function toBoundedEvidenceText(value: string, limit: number): string {
    return toEllipsizedText(value.replace(/\s+/g, ' ').trim(), limit);
}

function toBoundedMultilineEvidenceText(value: string, limit: number): string {
    const normalized = value
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[^\S\n]+/g, ' ').trimEnd())
        .join('\n')
        .trim();
    return toEllipsizedText(normalized, limit);
}

function toEllipsizedText(normalized: string, limit: number): string {
    return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
