import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { inspectRtcObservationChange } from '../validation-evidence/rtc-observation-change.mjs';
import { armPullRequestAutoMerge } from './ready-pull-request.mjs';

export async function publishRtcObservationPullRequest(input, dependencies) {
    await dependencies.verifyObservation(input);
    const observation = dependencies.loadObservation(input);
    assertRunIdentity(input, observation);
    dependencies.assertWorkspaceClean();
    if (dependencies.readDefaultBranch() !== 'main') {
        throw new Error('RTC observation publication default branch must be main');
    }

    dependencies.configureGitAuthentication();
    const baseCommit = dependencies.refreshMain();
    const mainState = dependencies.inspectMain({
        baseCommit,
        observation,
        sourceArchivePath: input.archivePath
    });
    if (mainState === 'published') {
        return { status: 'already-published', pullRequestUrl: undefined };
    }
    if (mainState !== 'missing') {
        throw new Error('RTC observation archive identity is already used on main');
    }

    const branchName = `automation/${observation.stream}-observation-gh${input.runId}-a${input.runAttempt}`;
    const branchInput = {
        baseCommit,
        branchName,
        observation,
        sourceArchivePath: input.archivePath
    };
    const branchState = dependencies.inspectBranch(branchInput);
    if (branchState === 'conflict') {
        throw new Error('RTC observation publication branch identity is already used');
    }
    let pullRequest = dependencies.findPullRequest(branchName);
    if (pullRequest !== undefined) {
        assertMatchingPullRequest(pullRequest, branchName);
    }
    if (branchState === 'missing') {
        const publicationCommit = dependencies.buildBranch(branchInput);
        dependencies.pushBranch({ ...branchInput, publicationCommit });
    }
    else if (branchState === 'stale') {
        const publicationCommit = dependencies.buildBranch(branchInput);
        dependencies.replaceBranch({ ...branchInput, publicationCommit });
    }
    if (pullRequest === undefined) {
        pullRequest = dependencies.openPullRequest({
            baseBranch: 'main',
            headBranch: branchName,
            title: `perf(rtc): archive ${observation.observationId}`,
            body: publicationBody(observation)
        });
    }
    assertMatchingPullRequest(pullRequest, branchName);
    if (!pullRequest.autoMergeArmed) {
        await dependencies.armAutoMerge(pullRequest.url);
    }
    return { status: 'pull-request-ready', pullRequestUrl: pullRequest.url };
}

export class RtcObservationPublicationShell {
    constructor({ repoRoot, execFile = execFileSync }) {
        this.repoRoot = repoRoot;
        this.execFile = execFile;
        this.worktrees = new Map();
        this.remoteBranches = new Map();
    }

    verifyObservation(input) {
        this.#run('npm', [
            'run',
            'perf:rtc-baseline',
            '--',
            'verify-observation',
            `--archive=${input.archivePath}`,
            `--index-entry=${input.indexEntryPath}`
        ]);
    }

    loadObservation(input) {
        const source = readFileSync(input.indexEntryPath, 'utf8');
        if (!source.endsWith('\n') || source.slice(0, -1).includes('\n') || source.length === 1) {
            throw new Error('RTC observation index input must be one newline-terminated JSON row');
        }
        const indexLine = source.slice(0, -1);
        const entry = JSON.parse(indexLine);
        if (JSON.stringify(entry) !== indexLine) {
            throw new Error('RTC observation index input must be canonical JSON');
        }
        const stream = observationStream(entry);
        return {
            stream,
            observationId: entry.observation.observationId,
            archivePath: entry.archive.path,
            indexPath: `performance-observations/${stream}/index.jsonl`,
            indexLine,
            sourceCommit: entry.observation.source.commit,
            outcome: entry.observation.primary.outcome,
            runId: entry.observation.workflow.runId,
            runAttempt: entry.observation.workflow.runAttempt,
            workflowUrl: entry.observation.workflow.url
        };
    }

    assertWorkspaceClean() {
        const status = this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
        if (status !== '') {
            throw new Error('RTC observation publication workspace must be clean');
        }
    }

    readDefaultBranch() {
        const repository = JSON.parse(
            this.#gh(['repo', 'view', '--json', 'defaultBranchRef'])
        );
        return repository.defaultBranchRef.name;
    }

    refreshMain() {
        this.#git([
            'fetch',
            '--no-tags',
            'origin',
            'refs/heads/main:refs/remotes/origin/main'
        ]);
        return this.#git(['rev-parse', 'refs/remotes/origin/main']).trim();
    }

    inspectMain({ baseCommit, observation, sourceArchivePath }) {
        const archiveExists = this.#revisionPathExists(baseCommit, observation.archivePath);
        const indexSource = this.#readRevisionFile(baseCommit, observation.indexPath) ?? '';
        const exactRows = indexSource.split('\n').filter((line) => line === observation.indexLine);
        if (archiveExists && exactRows.length === 1) {
            const sourceBlob = this.#git(['hash-object', '--no-filters', sourceArchivePath]).trim();
            const publishedBlob = this.#git(
                ['rev-parse', `${baseCommit}:${observation.archivePath}`]
            ).trim();
            return sourceBlob === publishedBlob ? 'published' : 'conflict';
        }
        if (
            archiveExists ||
            exactRows.length > 0 ||
            indexSource.includes(observation.observationId) ||
            indexSource.includes(observation.archivePath) ||
            (indexSource !== '' && !indexSource.endsWith('\n'))
        ) {
            return 'conflict';
        }
        return 'missing';
    }

    inspectBranch(input) {
        const branchReference = `refs/heads/${input.branchName}`;
        const remote = this.#git(['ls-remote', '--heads', 'origin', branchReference]).trim();
        if (remote === '') {
            return 'missing';
        }
        const [remoteCommit, remoteBranch, ...unexpected] = remote.split(/\s+/u);
        if (
            unexpected.length > 0 ||
            remoteBranch !== branchReference ||
            !/^[0-9a-f]{40}$/u.test(remoteCommit)
        ) {
            return 'conflict';
        }
        const remoteReference = `refs/remotes/origin/${input.branchName}`;
        this.#git([
            'fetch',
            '--no-tags',
            'origin',
            `+${branchReference}:${remoteReference}`
        ]);
        if (!this.#publicationCommitMatches({ ...input, publicationCommit: remoteReference })) {
            return 'conflict';
        }
        const parentCommit = this.#git(['rev-parse', `${remoteReference}^`]).trim();
        const parentIndex = this.#readRevisionFile(
            parentCommit,
            input.observation.indexPath
        ) ?? '';
        const currentMainIndex = this.#readRevisionFile(
            input.baseCommit,
            input.observation.indexPath
        ) ?? '';
        this.remoteBranches.set(input.branchName, remoteCommit);
        return parentIndex === currentMainIndex ? 'matching' : 'stale';
    }

    configureGitAuthentication() {
        this.#gh(['auth', 'setup-git']);
    }

    buildBranch(input) {
        const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'rtc-observation-publication-'));
        const worktree = path.join(temporaryRoot, 'worktree');
        try {
            this.#git(['worktree', 'add', '--detach', worktree, input.baseCommit]);
            const archiveDestination = path.join(worktree, input.observation.archivePath);
            const indexDestination = path.join(worktree, input.observation.indexPath);
            mkdirSync(path.dirname(archiveDestination), { recursive: true });
            mkdirSync(path.dirname(indexDestination), { recursive: true });
            copyFileSync(input.sourceArchivePath, archiveDestination);
            const currentIndex = this.#readRevisionFile(
                input.baseCommit,
                input.observation.indexPath
            ) ?? '';
            if (currentIndex !== '' && !currentIndex.endsWith('\n')) {
                throw new Error('remote main index changed during publication');
            }
            writeFileSync(indexDestination, `${currentIndex}${input.observation.indexLine}\n`, 'utf8');
            this.#git([
                'add',
                '--',
                input.observation.archivePath,
                input.observation.indexPath
            ], worktree);
            this.#git([
                '-c',
                'user.name=RTC Observation Bot',
                '-c',
                'user.email=rtc-observation-bot@users.noreply.github.com',
                'commit',
                '-m',
                `perf(rtc): archive ${input.observation.observationId}`
            ], worktree);
            const publicationCommit = this.#git(['rev-parse', 'HEAD'], worktree).trim();
            if (!this.#publicationCommitMatches({ ...input, publicationCommit, repoRoot: worktree })) {
                throw new Error('RTC observation publication commit failed exact integrity checks');
            }
            this.worktrees.set(input.branchName, { temporaryRoot, worktree });
            return publicationCommit;
        }
        catch (error) {
            this.#removeWorktree(temporaryRoot, worktree);
            throw error;
        }
    }

    pushBranch(input) {
        this.#pushBuiltBranch(input, [
            'push',
            'origin',
            `HEAD:refs/heads/${input.branchName}`
        ]);
    }

    replaceBranch(input) {
        const remoteCommit = this.remoteBranches.get(input.branchName);
        if (remoteCommit === undefined) {
            throw new Error('RTC observation publication branch lease is unavailable');
        }
        this.#pushBuiltBranch(input, [
            'push',
            `--force-with-lease=refs/heads/${input.branchName}:${remoteCommit}`,
            'origin',
            `HEAD:refs/heads/${input.branchName}`
        ]);
    }

    #pushBuiltBranch(input, pushArguments) {
        const paths = this.worktrees.get(input.branchName);
        if (paths === undefined) {
            throw new Error('RTC observation publication worktree is unavailable');
        }
        try {
            const currentMain = this.refreshMain();
            const expectedIndex = this.#readRevisionFile(
                input.baseCommit,
                input.observation.indexPath
            ) ?? '';
            const currentIndex = this.#readRevisionFile(
                currentMain,
                input.observation.indexPath
            ) ?? '';
            if (currentIndex !== expectedIndex) {
                throw new Error('remote main index changed during publication');
            }
            this.#git(pushArguments, paths.worktree);
        }
        finally {
            this.worktrees.delete(input.branchName);
            this.remoteBranches.delete(input.branchName);
            this.#removeWorktree(paths.temporaryRoot, paths.worktree);
        }
    }

    findPullRequest(branchName) {
        const source = this.#gh([
            'pr',
            'list',
            '--head',
            branchName,
            '--state',
            'all',
            '--limit',
            '10',
            '--json',
            'number,url,state,mergedAt,baseRefName,headRefName,autoMergeRequest'
        ]);
        const pullRequests = JSON.parse(source);
        if (pullRequests.length > 1) {
            throw new Error('RTC observation publication has multiple matching pull requests');
        }
        return pullRequests.length === 0 ? undefined : normalizePullRequest(pullRequests[0]);
    }

    openPullRequest(input) {
        const url = this.#gh([
            'pr',
            'create',
            '--base',
            input.baseBranch,
            '--head',
            input.headBranch,
            '--title',
            input.title,
            '--body',
            input.body
        ]).trim();
        return {
            url,
            state: 'OPEN',
            merged: false,
            baseBranch: input.baseBranch,
            headBranch: input.headBranch,
            autoMergeArmed: false
        };
    }

    armAutoMerge(pullRequestUrl) {
        armPullRequestAutoMerge(
            (executable, arguments_, options) => this.#run(executable, arguments_, options),
            pullRequestUrl
        );
    }

    #publicationCommitMatches(input) {
        const repoRoot = input.repoRoot ?? this.repoRoot;
        let parentCommit;
        try {
            parentCommit = this.#git(['rev-parse', `${input.publicationCommit}^`], repoRoot).trim();
            this.#git(['merge-base', '--is-ancestor', parentCommit, input.baseCommit], repoRoot);
        }
        catch {
            return false;
        }
        const inspection = inspectRtcObservationChange({
            repoRoot,
            base: parentCommit,
            head: input.publicationCommit
        });
        if (!inspection.observationOnly || inspection.archivePath !== input.observation.archivePath) {
            return false;
        }
        const parentIndex = this.#readRevisionFile(
            parentCommit,
            input.observation.indexPath,
            repoRoot
        ) ?? '';
        const branchIndex = this.#readRevisionFile(
            input.publicationCommit,
            input.observation.indexPath,
            repoRoot
        );
        const sourceBlob = this.#git(
            ['hash-object', '--no-filters', input.sourceArchivePath],
            repoRoot
        ).trim();
        const branchBlob = this.#git(
            ['rev-parse', `${input.publicationCommit}:${input.observation.archivePath}`],
            repoRoot
        ).trim();
        return branchIndex === `${parentIndex}${input.observation.indexLine}\n` &&
            sourceBlob === branchBlob;
    }

    #revisionPathExists(revision, repositoryPath) {
        try {
            this.#git(['cat-file', '-e', `${revision}:${repositoryPath}`], this.repoRoot, true);
            return true;
        }
        catch {
            return false;
        }
    }

    #readRevisionFile(revision, repositoryPath, repoRoot = this.repoRoot) {
        try {
            return this.#git(['show', `${revision}:${repositoryPath}`], repoRoot, true);
        }
        catch {
            return undefined;
        }
    }

    #removeWorktree(temporaryRoot, worktree) {
        try {
            this.#git(['worktree', 'remove', '--force', worktree]);
        }
        catch {
            // The temporary directory is still bounded and removed below when worktree setup failed.
        }
        rmSync(temporaryRoot, { recursive: true, force: true });
    }

    #git(arguments_, cwd = this.repoRoot, silent = false) {
        return this.#run('git', arguments_, {
            cwd,
            encoding: 'utf8',
            stdio: silent ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe']
        });
    }

    #gh(arguments_) {
        return this.#run('gh', arguments_, { cwd: this.repoRoot, encoding: 'utf8' });
    }

    #run(executable, arguments_, options = {}) {
        return this.execFile(executable, arguments_, {
            cwd: options.cwd ?? this.repoRoot,
            encoding: 'utf8',
            stdio: options.stdio ?? ['ignore', 'pipe', 'pipe']
        });
    }
}

function assertRunIdentity(input, observation) {
    if (observation.runId !== input.runId || observation.runAttempt !== input.runAttempt) {
        throw new Error('RTC observation input does not match the requested workflow run identity');
    }
}

function assertMatchingPullRequest(pullRequest, branchName) {
    if (
        pullRequest.state !== 'OPEN' ||
        pullRequest.merged ||
        pullRequest.baseBranch !== 'main' ||
        pullRequest.headBranch !== branchName
    ) {
        throw new Error('RTC observation pull request does not match the publication branch');
    }
}

function publicationBody(observation) {
    return [
        `Automated ${observation.stream.toUpperCase()} performance observation.`,
        '',
        `- Observation: \`${observation.observationId}\``,
        `- Observed source: \`${observation.sourceCommit}\``,
        `- Workflow: ${observation.workflowUrl}`,
        `- Primary outcome: \`${observation.outcome}\``,
        '',
        'This records the checked-out source snapshot; main may continue to move independently.'
    ].join('\n');
}

function observationStream(entry) {
    const stream = entry.schema === 'rallar.rtc-performance-observation.index-entry.v1'
        ? 'rtc-b05'
        : entry.schema === 'rallar.rtc-b06-performance-observation.index-entry.v1'
        ? 'rtc-b06'
        : null;
    if (
        stream === null ||
        typeof entry.archive?.path !== 'string' ||
        !entry.archive.path.startsWith(`performance-observations/${stream}/`)
    ) {
        throw new Error('RTC observation index schema and archive stream must match');
    }
    return stream;
}

function normalizePullRequest(pullRequest) {
    return {
        url: pullRequest.url,
        state: pullRequest.state,
        merged: pullRequest.mergedAt !== null,
        baseBranch: pullRequest.baseRefName,
        headBranch: pullRequest.headRefName,
        autoMergeArmed: pullRequest.autoMergeRequest !== null
    };
}
