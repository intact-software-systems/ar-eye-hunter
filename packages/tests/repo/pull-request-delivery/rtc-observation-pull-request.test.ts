import { describe, expect, it } from 'vitest';

import { publishRtcObservationPullRequest } from '../../../../scripts/pull-request-delivery/rtc-observation-pull-request.mjs';

const input = {
    repoRoot: '/repository',
    archivePath: '/capture/observation.zip',
    indexEntryPath: '/capture/index-entry.jsonl',
    runId: 123456789,
    runAttempt: 2
};

const observation = {
    stream: 'rtc-b05',
    observationId: '20260827T031500Z-eaf526518c70-e2-browser-gh123456789-a2',
    archivePath: 'performance-observations/rtc-b05/2026/08/27/20260827T031500Z-eaf526518c70-e2-browser-gh123456789-a2.zip',
    indexPath: 'performance-observations/rtc-b05/index.jsonl',
    indexLine: '{"schema":"rallar.rtc-performance-observation.index-entry.v1"}',
    sourceCommit: 'eaf526518c70e3b396dad91c008125a622b38b00',
    outcome: 'passed',
    runId: 123456789,
    runAttempt: 2,
    workflowUrl: 'https://github.com/example/repository/actions/runs/123456789'
};

describe('RTC observation pull-request publication', () => {
    it('verifies before mutation and publishes one disposable main pull request', async () => {
        const fixture = publicationFixture();

        const result = await publishRtcObservationPullRequest(input, fixture.dependencies);

        expect(result).toEqual({
            status: 'pull-request-ready',
            pullRequestUrl: 'https://github.com/example/repository/pull/91'
        });
        expect(fixture.calls).toEqual([
            'verify',
            'load-observation',
            'assert-clean',
            'read-default-branch',
            'configure-git-authentication',
            'refresh-main',
            'inspect-main',
            'inspect-branch',
            'find-pr',
            'build-branch',
            'push-branch',
            'open-pr',
            'arm-auto-merge'
        ]);
        expect(fixture.branchInputs).toEqual([
            expect.objectContaining({
                baseCommit: '1'.repeat(40),
                branchName: 'automation/rtc-b05-observation-gh123456789-a2',
                observation
            })
        ]);
        expect(fixture.pullRequestInputs).toEqual([
            expect.objectContaining({
                baseBranch: 'main',
                headBranch: 'automation/rtc-b05-observation-gh123456789-a2',
                title: `perf(rtc): archive ${observation.observationId}`,
                body: expect.stringMatching(/main may continue to move/u)
            })
        ]);
    });

    it('uses the RTC-B06 stream identity for its branch and publication copy', async () => {
        const b06Observation = {
            ...observation,
            stream: 'rtc-b06',
            observationId: '20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3',
            archivePath: 'performance-observations/rtc-b06/2026/08/30/' +
                '20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3.zip',
            indexPath: 'performance-observations/rtc-b06/index.jsonl',
            indexLine: '{"schema":"rallar.rtc-b06-performance-observation.index-entry.v1"}',
            runId: 987654321,
            runAttempt: 3
        };
        const fixture = publicationFixture({ observation: b06Observation });

        await publishRtcObservationPullRequest(
            { ...input, runId: 987654321, runAttempt: 3 },
            fixture.dependencies
        );

        expect(fixture.branchInputs).toEqual([
            expect.objectContaining({
                branchName: 'automation/rtc-b06-observation-gh987654321-a3',
                observation: b06Observation
            })
        ]);
        expect(fixture.pullRequestInputs).toEqual([
            expect.objectContaining({
                headBranch: 'automation/rtc-b06-observation-gh987654321-a3'
            })
        ]);
    });

    it('rebuilds a stale matching branch on the current main index with an exact lease', async () => {
        const fixture = publicationFixture({
            branchState: 'stale',
            pullRequest: {
                url: 'https://github.com/example/repository/pull/90',
                state: 'OPEN',
                merged: false,
                baseBranch: 'main',
                headBranch: 'automation/rtc-b05-observation-gh123456789-a2',
                autoMergeArmed: true
            }
        });

        const result = await publishRtcObservationPullRequest(input, fixture.dependencies);

        expect(result.pullRequestUrl).toContain('/pull/90');
        expect(fixture.calls).toContain('build-branch');
        expect(fixture.calls).toContain('replace-branch');
        expect(fixture.calls).not.toContain('push-branch');
        expect(fixture.calls).not.toContain('open-pr');
        expect(fixture.calls).not.toContain('arm-auto-merge');
    });

    it('resumes a matching branch and pull request without another commit or push', async () => {
        const fixture = publicationFixture({
            branchState: 'matching',
            pullRequest: {
                url: 'https://github.com/example/repository/pull/90',
                state: 'OPEN',
                merged: false,
                baseBranch: 'main',
                headBranch: 'automation/rtc-b05-observation-gh123456789-a2',
                autoMergeArmed: false
            }
        });

        const result = await publishRtcObservationPullRequest(input, fixture.dependencies);

        expect(result.pullRequestUrl).toContain('/pull/90');
        expect(fixture.calls).not.toContain('build-branch');
        expect(fixture.calls).not.toContain('push-branch');
        expect(fixture.calls).not.toContain('open-pr');
        expect(fixture.calls.at(-1)).toBe('arm-auto-merge');
    });

    it('reports an observation already present on main without mutating the repository', async () => {
        const fixture = publicationFixture({ mainState: 'published' });

        const result = await publishRtcObservationPullRequest(input, fixture.dependencies);

        expect(result).toEqual({ status: 'already-published', pullRequestUrl: undefined });
        expect(fixture.mutations).toEqual([]);
    });

    it.each([
        ['dirty workspace', { dirty: true }, 'publication workspace must be clean'],
        ['non-main default branch', { defaultBranch: 'release' }, 'default branch must be main'],
        ['existing conflicting archive', { mainState: 'conflict' }, 'archive identity is already used'],
        ['existing conflicting branch', { branchState: 'conflict' }, 'publication branch identity is already used'],
        ['index race', { buildError: 'remote main index changed during publication' }, 'index changed']
    ])('fails closed for %s', async (_name, configuration, expected) => {
        const fixture = publicationFixture(configuration as PublicationFixtureConfiguration);

        await expect(
            publishRtcObservationPullRequest(input, fixture.dependencies)
        ).rejects.toThrow(expected);

        expect(fixture.calls[0]).toBe('verify');
        expect(fixture.calls).not.toContain('open-pr');
        expect(fixture.calls).not.toContain('arm-auto-merge');
    });

    it('does not inspect or mutate repository state when package verification fails', async () => {
        const fixture = publicationFixture({ verifyError: 'invalid RTC archive' });

        await expect(
            publishRtcObservationPullRequest(input, fixture.dependencies)
        ).rejects.toThrow('invalid RTC archive');

        expect(fixture.calls).toEqual(['verify']);
        expect(fixture.mutations).toEqual([]);
    });
});

interface PullRequestState {
    readonly url: string;
    readonly state: 'OPEN' | 'CLOSED';
    readonly merged: boolean;
    readonly baseBranch: string;
    readonly headBranch: string;
    readonly autoMergeArmed: boolean;
}

interface PublicationFixtureConfiguration {
    readonly branchState?: 'missing' | 'matching' | 'stale' | 'conflict';
    readonly buildError?: string;
    readonly defaultBranch?: string;
    readonly dirty?: boolean;
    readonly mainState?: 'missing' | 'published' | 'conflict';
    readonly observation?: typeof observation;
    readonly pullRequest?: PullRequestState;
    readonly verifyError?: string;
}

interface PublicationBranchInput {
    readonly baseCommit: string;
    readonly branchName: string;
    readonly observation: typeof observation;
    readonly sourceArchivePath: string;
}

interface ObservationPullRequestInput {
    readonly baseBranch: string;
    readonly headBranch: string;
    readonly title: string;
    readonly body: string;
}

function publicationFixture(configuration: PublicationFixtureConfiguration = {}) {
    const calls: string[] = [];
    const mutations: string[] = [];
    const branchInputs: PublicationBranchInput[] = [];
    const pullRequestInputs: ObservationPullRequestInput[] = [];
    const dependencies = {
        async verifyObservation() {
            calls.push('verify');
            if (configuration.verifyError !== undefined) {
                throw new Error(configuration.verifyError);
            }
        },
        loadObservation() {
            calls.push('load-observation');
            return configuration.observation ?? observation;
        },
        assertWorkspaceClean() {
            calls.push('assert-clean');
            if (configuration.dirty === true) {
                throw new Error('publication workspace must be clean');
            }
        },
        readDefaultBranch() {
            calls.push('read-default-branch');
            return configuration.defaultBranch ?? 'main';
        },
        refreshMain() {
            calls.push('refresh-main');
            return '1'.repeat(40);
        },
        inspectMain() {
            calls.push('inspect-main');
            return configuration.mainState ?? 'missing';
        },
        inspectBranch() {
            calls.push('inspect-branch');
            return configuration.branchState ?? 'missing';
        },
        configureGitAuthentication() {
            calls.push('configure-git-authentication');
        },
        buildBranch(branchInput: PublicationBranchInput) {
            calls.push('build-branch');
            mutations.push('build-branch');
            branchInputs.push(branchInput);
            if (configuration.buildError !== undefined) {
                throw new Error(configuration.buildError);
            }
            return '2'.repeat(40);
        },
        pushBranch() {
            calls.push('push-branch');
            mutations.push('push-branch');
        },
        replaceBranch() {
            calls.push('replace-branch');
            mutations.push('replace-branch');
        },
        findPullRequest() {
            calls.push('find-pr');
            return configuration.pullRequest;
        },
        openPullRequest(pullRequestInput: ObservationPullRequestInput) {
            calls.push('open-pr');
            mutations.push('open-pr');
            pullRequestInputs.push(pullRequestInput);
            return {
                url: 'https://github.com/example/repository/pull/91',
                state: 'OPEN' as const,
                merged: false,
                baseBranch: 'main',
                headBranch: pullRequestInput.headBranch,
                autoMergeArmed: false
            };
        },
        armAutoMerge() {
            calls.push('arm-auto-merge');
            mutations.push('arm-auto-merge');
        }
    };
    return { calls, mutations, branchInputs, pullRequestInputs, dependencies };
}
