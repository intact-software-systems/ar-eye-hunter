import type { RtcBaselineIssueDto, RtcBaselineSampleDto } from '../contracts/rtc-baseline-contracts.ts';
import {
    resolveRtcB06ReleaseEnvironment,
    type RtcB06DiagnosticSelection
} from '../observation/read-rtc-b06-diagnostic-selection.ts';

export function validateRtcB06ReleaseEvidence(
    sample: RtcBaselineSampleDto,
    selection: RtcB06DiagnosticSelection
): readonly RtcBaselineIssueDto[] {
    const raw = sample.rawEvidence;
    const release = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw.resultRelease : undefined;
    if (typeof release !== 'object' || release === null || Array.isArray(release)) {
        return [releaseIssue('Actual producer release evidence is unavailable.')];
    }
    const observed = release.raw === null || typeof release.raw === 'string'
        ? resolveRtcB06ReleaseEnvironment(sample.identity, release.raw ?? undefined)
        : undefined;
    const rawEnabled = release.raw === null ? false : observed?.ok ? observed.value.value : undefined;
    if (
        release.status !== 'verified' || release.enabled !== selection.releaseResultsAfterCapture ||
        rawEnabled !== release.enabled
    ) {
        return [
            releaseIssue('Actual producer release selection contradicts initialized configuration or was not verified.')
        ];
    }
    if (!selection.releaseResultsAfterCapture) {
        return release.releasedRoots === 0 ? [] : [releaseIssue('An unselected producer reports released results.')];
    }
    const sources = release.sources;
    if (
        typeof release.runId !== 'string' || !release.runId || typeof release.releasedRoots !== 'number' ||
        !Number.isSafeInteger(release.releasedRoots) || release.releasedRoots < 1 || !Array.isArray(sources) ||
        sources.length !== 3
    ) {
        return [releaseIssue('Complete acknowledged release recovery is unavailable.')];
    }
    for (const fileName of ['results.jsonl', 'events.jsonl', 'result-receipts.jsonl']) {
        const path = `artifacts/journals/${sample.identity.sampleId}-${fileName}`;
        const matching = sources.filter((source) =>
            typeof source === 'object' && source !== null && !Array.isArray(source) && source.relativePath === path
        );
        const stored = sample.rawReferences.filter((reference) => reference.relativePath === path);
        const source = matching[0];
        if (
            matching.length !== 1 || stored.length !== 1 || typeof source !== 'object' || source === null ||
            Array.isArray(source) ||
            source.bytes !== stored[0]!.bytes || source.sha256 !== stored[0]!.sha256
        ) {
            return [
                releaseIssue(
                    'Released payload recovery must reference the exact complete result, event and receipt bytes.'
                )
            ];
        }
    }
    return [];
}

function releaseIssue(message: string): RtcBaselineIssueDto {
    return { path: '$.rawEvidence.resultRelease', code: 'result-release-unverified', message };
}
