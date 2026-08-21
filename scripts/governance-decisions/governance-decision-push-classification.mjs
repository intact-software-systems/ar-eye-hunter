const governanceReceiptPathPattern = /^governance\/decisions\/[^/]+\.json$/u;

export function classifyGovernancePushCandidate(classificationInput) {
    const governanceCandidate = classificationInput.subject.startsWith('governance(') ||
        classificationInput.changedPaths.some((changedPath) => governanceReceiptPathPattern.test(changedPath));
    return { governanceCandidate };
}

export function resolveGovernancePushClassification(classificationInput) {
    if (classificationInput.eventName !== 'push') {
        return { decisionOnly: false, invalidGovernance: false };
    }
    if (classificationInput.candidateOutcome !== 'success') {
        return { decisionOnly: false, invalidGovernance: true };
    }
    if (!classificationInput.governanceCandidate) {
        return { decisionOnly: false, invalidGovernance: false };
    }
    if (classificationInput.verificationOutcome === 'success') {
        return { decisionOnly: true, invalidGovernance: false };
    }
    return { decisionOnly: false, invalidGovernance: true };
}
