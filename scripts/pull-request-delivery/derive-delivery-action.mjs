export function deriveDeliveryAction(pullRequest) {
    if (pullRequest === undefined) {
        return 'OPEN_DRAFT';
    }

    if (pullRequest.merged) {
        return 'DONE';
    }

    if (pullRequest.state === 'CLOSED') {
        return 'STOP_CLOSED';
    }

    if (pullRequest.baseRefName !== pullRequest.defaultBranch) {
        return 'STOP_WRONG_BASE';
    }

    if (pullRequest.mergeable === 'CONFLICTING' || pullRequest.mergeStateStatus === 'DIRTY') {
        return 'REPAIR_CONFLICT';
    }

    if (pullRequest.isDraft) {
        return 'WORK';
    }

    if (pullRequest.mergeable === 'UNKNOWN' || pullRequest.mergeStateStatus === 'UNKNOWN') {
        return 'WAIT_GITHUB';
    }

    if (pullRequest.checks === 'FAILING') {
        return 'REPAIR_CHECK';
    }

    if (pullRequest.checks === 'PENDING') {
        return 'WAIT_CI';
    }

    if (pullRequest.reviewDecision !== 'APPROVED') {
        return 'AWAIT_REVIEW_OR_ADMIN_MERGE';
    }

    if (!pullRequest.autoMergeArmed) {
        return 'ARM_AUTO_MERGE';
    }

    return 'WAIT_MERGE';
}
