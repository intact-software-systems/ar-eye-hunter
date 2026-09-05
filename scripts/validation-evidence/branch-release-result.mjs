export function validateBranchReleaseConclusion(input) {
    const cancellationIssue = resolveCancellationIssue(input);
    if (cancellationIssue !== undefined) {
        return [cancellationIssue];
    }

    const issues = [];
    if (input.governanceResult !== 'success') {
        issues.push('Governance Gate did not succeed');
    }
    if (input.selectionResult !== 'success') {
        issues.push('validation-evidence selection did not succeed');
    }
    return [...issues, ...validateModeConclusion(input)];
}

function resolveCancellationIssue(input) {
    const cancelledJobs = [
        ['Governance Gate', input.governanceResult],
        ['validation-evidence selection', input.selectionResult],
        ['broad Release Gate', input.releaseResult],
        ['validation-evidence publication', input.publicationResult],
        ['RTC observation integrity', input.rtcObservationResult]
    ].filter(([, result]) => result === 'cancelled');
    if (cancelledJobs.length === 0) {
        return undefined;
    }
    const names = cancelledJobs.map(([name]) => name).join(', ');
    return `run cancelled before it could conclude (${names}); a superseding run decides this branch`;
}

function validateModeConclusion(input) {
    const issues = [];
    if (input.mode === 'reuse') {
        if (input.reuse !== 'true') {
            issues.push('reuse mode requires validation-evidence reuse to be true');
        }
        if (
            input.releaseResult !== 'skipped' ||
            input.publicationResult !== 'skipped' ||
            input.rtcObservationResult !== 'skipped'
        ) {
            issues.push('reused evidence requires broad validation and publication to be skipped');
        }
        return issues;
    }
    if (input.mode === 'rtc-observation') {
        if (input.reuse !== 'false') {
            issues.push('RTC observation mode requires validation-evidence reuse to be false');
        }
        if (input.releaseResult !== 'skipped' || input.publicationResult !== 'skipped') {
            issues.push('RTC observation mode requires broad validation and publication to be skipped');
        }
        if (input.rtcObservationResult !== 'success') {
            issues.push('RTC observation integrity did not succeed');
        }
        return issues;
    }
    if (input.mode === 'invalid-rtc-observation') {
        issues.push('RTC observation store change is not an exact verified append');
        return issues;
    }
    if (input.mode !== 'broad') {
        issues.push('validation mode must be broad, reuse, or rtc-observation');
        return issues;
    }
    if (input.reuse !== 'false') {
        issues.push('broad validation mode requires validation-evidence reuse to be false');
    }
    if (input.releaseResult !== 'success') {
        issues.push('broad Release Gate did not succeed');
    }
    if (input.publicationResult !== 'success') {
        issues.push('fresh validation evidence was not published');
    }
    if (input.rtcObservationResult !== 'skipped') {
        issues.push('broad validation requires RTC observation integrity to be skipped');
    }
    return issues;
}
