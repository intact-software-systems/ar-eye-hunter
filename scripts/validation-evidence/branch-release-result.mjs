export function validateBranchReleaseConclusion({
    governanceResult,
    selectionResult,
    mode,
    reuse,
    releaseResult,
    publicationResult,
    rtcObservationResult
}) {
    // A cancelled upstream job leaves its result and every output it feeds empty, so the checks
    // below would report a chain of derived failures instead of the one fact that matters.
    // A superseding run decides the branch; this one has nothing to conclude.
    const cancelledJobs = [
        ['Governance Gate', governanceResult],
        ['validation-evidence selection', selectionResult],
        ['broad Release Gate', releaseResult],
        ['validation-evidence publication', publicationResult],
        ['RTC observation integrity', rtcObservationResult]
    ].filter(([, result]) => result === 'cancelled');
    if (cancelledJobs.length > 0) {
        return [
            `run cancelled before it could conclude (${
                cancelledJobs
                    .map(([name]) => name)
                    .join(', ')
            }); a superseding run decides this branch`
        ];
    }

    const issues = [];
    if (governanceResult !== 'success') {
        issues.push('Governance Gate did not succeed');
    }
    if (selectionResult !== 'success') {
        issues.push('validation-evidence selection did not succeed');
    }

    if (mode === 'reuse') {
        if (reuse !== 'true') {
            issues.push('reuse mode requires validation-evidence reuse to be true');
        }
        if (
            releaseResult !== 'skipped' ||
            publicationResult !== 'skipped' ||
            rtcObservationResult !== 'skipped'
        ) {
            issues.push('reused evidence requires broad validation and publication to be skipped');
        }
        return issues;
    }
    if (mode === 'rtc-observation') {
        if (reuse !== 'false') {
            issues.push('RTC observation mode requires validation-evidence reuse to be false');
        }
        if (releaseResult !== 'skipped' || publicationResult !== 'skipped') {
            issues.push('RTC observation mode requires broad validation and publication to be skipped');
        }
        if (rtcObservationResult !== 'success') {
            issues.push('RTC observation integrity did not succeed');
        }
        return issues;
    }
    if (mode === 'invalid-rtc-observation') {
        issues.push('RTC observation store change is not an exact verified append');
        return issues;
    }
    if (mode !== 'broad') {
        issues.push('validation mode must be broad, reuse, or rtc-observation');
        return issues;
    }
    if (reuse !== 'false') {
        issues.push('broad validation mode requires validation-evidence reuse to be false');
    }
    if (releaseResult !== 'success') {
        issues.push('broad Release Gate did not succeed');
    }
    if (publicationResult !== 'success') {
        issues.push('fresh validation evidence was not published');
    }
    if (rtcObservationResult !== 'skipped') {
        issues.push('broad validation requires RTC observation integrity to be skipped');
    }
    return issues;
}
