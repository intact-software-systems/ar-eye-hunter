import { describe, expect, it } from 'vitest';

import { deriveDeliveryAction } from '../../../../scripts/pull-request-delivery/derive-delivery-action.mjs';

const openPullRequest = {
    state: 'OPEN',
    merged: false,
    isDraft: false,
    baseRefName: 'main',
    defaultBranch: 'main',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checks: 'PASSING',
    reviewDecision: 'REVIEW_REQUIRED',
    autoMergeArmed: false
};

describe('pull request delivery action', () => {
    it.each([
        {
            name: 'opens a draft when the branch has no pull request',
            pullRequest: undefined,
            expected: 'OPEN_DRAFT'
        },
        {
            name: 'continues implementation while the pull request is a draft',
            pullRequest: { ...openPullRequest, isDraft: true },
            expected: 'WORK'
        },
        {
            name: 'reports a real source conflict before draft implementation state',
            pullRequest: {
                ...openPullRequest,
                isDraft: true,
                mergeable: 'CONFLICTING',
                mergeStateStatus: 'DIRTY'
            },
            expected: 'REPAIR_CONFLICT'
        },
        {
            name: 'stops when the pull request was closed without merging',
            pullRequest: { ...openPullRequest, state: 'CLOSED' },
            expected: 'STOP_CLOSED'
        },
        {
            name: 'treats merged as terminal despite stale failure fields',
            pullRequest: {
                ...openPullRequest,
                state: 'CLOSED',
                merged: true,
                mergeable: 'CONFLICTING',
                mergeStateStatus: 'DIRTY',
                checks: 'FAILING',
                reviewDecision: 'CHANGES_REQUESTED'
            },
            expected: 'DONE'
        },
        {
            name: 'stops when the pull request targets a branch other than the default branch',
            pullRequest: { ...openPullRequest, baseRefName: 'release' },
            expected: 'STOP_WRONG_BASE'
        },
        {
            name: 'waits while GitHub calculates mergeability',
            pullRequest: {
                ...openPullRequest,
                mergeable: 'UNKNOWN',
                mergeStateStatus: 'UNKNOWN'
            },
            expected: 'WAIT_GITHUB'
        },
        {
            name: 'reports the real conflict before check or review state',
            pullRequest: {
                ...openPullRequest,
                mergeable: 'CONFLICTING',
                mergeStateStatus: 'DIRTY',
                checks: 'PENDING',
                reviewDecision: 'REVIEW_REQUIRED'
            },
            expected: 'REPAIR_CONFLICT'
        },
        {
            name: 'repairs a failed required check',
            pullRequest: { ...openPullRequest, checks: 'FAILING' },
            expected: 'REPAIR_CHECK'
        },
        {
            name: 'waits for pending required checks',
            pullRequest: { ...openPullRequest, checks: 'PENDING' },
            expected: 'WAIT_CI'
        },
        {
            name: 'ignores a behind base when the pull request remains mergeable',
            pullRequest: {
                ...openPullRequest,
                mergeStateStatus: 'BEHIND'
            },
            expected: 'AWAIT_REVIEW_OR_ADMIN_MERGE'
        },
        {
            name: 'awaits review or administrator merge after requested changes',
            pullRequest: {
                ...openPullRequest,
                reviewDecision: 'CHANGES_REQUESTED'
            },
            expected: 'AWAIT_REVIEW_OR_ADMIN_MERGE'
        },
        {
            name: 'arms auto-merge after approval',
            pullRequest: {
                ...openPullRequest,
                reviewDecision: 'APPROVED'
            },
            expected: 'ARM_AUTO_MERGE'
        },
        {
            name: 'waits for GitHub after approval and auto-merge arming',
            pullRequest: {
                ...openPullRequest,
                reviewDecision: 'APPROVED',
                autoMergeArmed: true
            },
            expected: 'WAIT_MERGE'
        }
    ])('$name', ({ pullRequest, expected }) => {
        expect(deriveDeliveryAction(pullRequest)).toBe(expected);
    });
});
