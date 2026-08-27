import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    publishRtcObservationPullRequest,
    RtcObservationPublicationShell
} from '../../../../scripts/pull-request-delivery/rtc-observation-pull-request.mjs';

const fixtureRoots: string[] = [];

afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('RTC observation Git publication shell', () => {
    it('pushes only the exact archive commit on a disposable branch and leaves main unchanged', async () => {
        const fixture = gitPublicationFixture();
        const shell = new RtcObservationPublicationShell({ repoRoot: fixture.repository });
        const calls: string[] = [];
        shell.verifyObservation = () => calls.push('verify');
        shell.readDefaultBranch = () => 'main';
        shell.configureGitAuthentication = () => undefined;
        shell.findPullRequest = () => undefined;
        shell.openPullRequest = () => ({
            url: 'https://github.com/example/repository/pull/91',
            state: 'OPEN',
            merged: false,
            baseBranch: 'main',
            headBranch: fixture.branchName,
            autoMergeArmed: false
        });
        shell.armAutoMerge = () => calls.push('arm-auto-merge');

        await publishRtcObservationPullRequest(fixture.input, shell);

        runGit(fixture.repository, ['fetch', 'origin', fixture.branchName]);
        const branchCommit = runGit(fixture.repository, ['rev-parse', 'FETCH_HEAD']).trim();
        expect(runGit(fixture.repository, ['rev-parse', `${branchCommit}^`]).trim()).toBe(
            fixture.mainCommit
        );
        expect(
            runGit(fixture.repository, [
                'diff',
                '--name-status',
                '--no-renames',
                fixture.mainCommit,
                branchCommit
            ]).trim().split('\n')
        ).toEqual([
            `A\t${fixture.archiveRepositoryPath}`,
            'A\tperformance-observations/rtc-b05/index.jsonl'
        ]);
        expect(
            runGit(fixture.repository, [
                'show',
                `${branchCommit}:performance-observations/rtc-b05/index.jsonl`
            ])
        ).toBe(`${fixture.indexLine}\n`);
        expect(runGit(fixture.repository, ['rev-parse', 'origin/main']).trim()).toBe(
            fixture.mainCommit
        );
        expect(calls).toEqual(['verify', 'arm-auto-merge']);
    });
});

function gitPublicationFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'rtc-observation-publication-test-'));
    fixtureRoots.push(root);
    const origin = path.join(root, 'origin.git');
    const seed = path.join(root, 'seed');
    const repository = path.join(root, 'repository');
    runGit(root, ['init', '--bare', '--quiet', origin]);
    mkdirSync(seed);
    runGit(seed, ['init', '--initial-branch=main', '--quiet']);
    runGit(seed, ['config', 'user.name', 'RTC Publication Test']);
    runGit(seed, ['config', 'user.email', 'rtc-publication@example.invalid']);
    writeFileSync(path.join(seed, 'package.json'), '{}\n');
    runGit(seed, ['add', 'package.json']);
    runGit(seed, ['commit', '--quiet', '-m', 'base']);
    runGit(seed, ['remote', 'add', 'origin', origin]);
    runGit(seed, ['push', '--quiet', '-u', 'origin', 'main']);
    runGit(root, ['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    runGit(root, ['clone', '--quiet', origin, repository]);

    const observationId = '20260827T031500Z-eaf526518c70-e2-browser-gh123456789-a2';
    const archiveRepositoryPath =
        `performance-observations/rtc-b05/2026/08/27/${observationId}.zip`;
    const archivePath = path.join(root, 'observation.zip');
    const indexEntryPath = path.join(root, 'index-entry.jsonl');
    writeFileSync(archivePath, 'deterministic-zip-fixture');
    const indexEntry = {
        schema: 'rallar.rtc-performance-observation.index-entry.v1',
        observation: {
            observationId,
            source: { commit: 'eaf526518c70e3b396dad91c008125a622b38b00' },
            workflow: {
                runId: 123456789,
                runAttempt: 2,
                url: 'https://github.com/example/repository/actions/runs/123456789'
            },
            primary: { outcome: 'passed' }
        },
        archive: { path: archiveRepositoryPath }
    };
    const indexLine = JSON.stringify(indexEntry);
    writeFileSync(indexEntryPath, `${indexLine}\n`);
    return {
        repository,
        mainCommit: runGit(repository, ['rev-parse', 'HEAD']).trim(),
        branchName: 'automation/rtc-b05-observation-gh123456789-a2',
        archiveRepositoryPath,
        indexLine,
        input: {
            repoRoot: repository,
            archivePath,
            indexEntryPath,
            runId: 123456789,
            runAttempt: 2
        }
    };
}

function runGit(root: string, arguments_: readonly string[]): string {
    return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' });
}
