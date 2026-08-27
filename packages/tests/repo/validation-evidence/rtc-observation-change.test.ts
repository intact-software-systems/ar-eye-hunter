import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { inspectRtcObservationChange } from '../../../../scripts/validation-evidence/rtc-observation-change.mjs';

const observationId = '20260827T031500Z-eaf526518c70-e2-browser-gh123456789-a2';
const archivePath = `performance-observations/rtc-b05/2026/08/27/${observationId}.zip`;
const indexPath = 'performance-observations/rtc-b05/index.jsonl';
const fixtureRoots: string[] = [];

afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('RTC observation-only change', () => {
    it.each([
        ['first index', false],
        ['append to an existing index', true]
    ])('accepts one create-new ZIP and one canonical %s row', (_name, existingIndex) => {
        const fixture = createFixture(existingIndex);
        const head = commit(fixture.root, 'observation', {
            [archivePath]: 'zip-bytes',
            [indexPath]: `${fixture.oldIndex}${indexLine(archivePath)}\n`
        });

        expect(inspectRtcObservationChange({
            repoRoot: fixture.root,
            base: fixture.base,
            head
        })).toEqual({
            observationOnly: true,
            reason: 'rtc-observation-only',
            archivePath,
            indexEntry: JSON.parse(indexLine(archivePath))
        });
    });

    it.each([
        [
            'missing final newline',
            (fixture: Fixture) => ({
                [archivePath]: 'zip-bytes',
                [indexPath]: `${fixture.oldIndex}${indexLine(archivePath)}`
            })
        ],
        [
            'changed historical row',
            (fixture: Fixture) => ({
                [archivePath]: 'zip-bytes',
                [indexPath]: `${fixture.oldIndex.replace('old.zip', 'changed.zip')}${indexLine(archivePath)}\n`
            })
        ],
        [
            'two archives',
            (fixture: Fixture) => ({
                [archivePath]: 'zip-bytes',
                [archivePath.replace('.zip', '-other.zip')]: 'zip-bytes',
                [indexPath]: `${fixture.oldIndex}${indexLine(archivePath)}\n`
            })
        ],
        [
            'unrelated file',
            (fixture: Fixture) => ({
                [archivePath]: 'zip-bytes',
                [indexPath]: `${fixture.oldIndex}${indexLine(archivePath)}\n`,
                'docs/unrelated.md': 'changed\n'
            })
        ],
        [
            'uppercase archive path',
            (fixture: Fixture) => {
                const uppercase = archivePath.replace('/rtc-b05/', '/RTC-B05/');
                return {
                    [uppercase]: 'zip-bytes',
                    [indexPath]: `${fixture.oldIndex}${indexLine(uppercase)}\n`
                };
            }
        ],
        [
            'archive replacement',
            (fixture: Fixture) => ({
                [fixture.oldArchivePath]: 'replacement',
                [indexPath]: `${fixture.oldIndex}${indexLine(fixture.oldArchivePath)}\n`
            })
        ]
    ])('rejects %s', (_name, change) => {
        const fixture = createFixture(true);
        const head = commit(fixture.root, 'invalid observation', change(fixture));

        expect(inspectRtcObservationChange({
            repoRoot: fixture.root,
            base: fixture.base,
            head
        })).toMatchObject({ observationOnly: false });
    });
});

interface Fixture {
    root: string;
    base: string;
    oldIndex: string;
    oldArchivePath: string;
}

function createFixture(existingIndex: boolean): Fixture {
    const root = mkdtempSync(path.join(tmpdir(), 'rtc-observation-change-'));
    fixtureRoots.push(root);
    runGit(root, ['init', '--initial-branch=feature', '--quiet']);
    runGit(root, ['config', 'user.name', 'RTC Observation Test']);
    runGit(root, ['config', 'user.email', 'rtc-observation@example.invalid']);
    const oldArchivePath = 'performance-observations/rtc-b05/2026/08/26/old.zip';
    const oldIndex = existingIndex ? `${indexLine(oldArchivePath)}\n` : '';
    const files: Readonly<Record<string, string>> = existingIndex
        ? { [oldArchivePath]: 'old-zip', [indexPath]: oldIndex, 'package.json': '{}\n' }
        : { 'package.json': '{}\n' };
    return { root, base: commit(root, 'base', files), oldIndex, oldArchivePath };
}

function indexLine(path: string) {
    return JSON.stringify({ archive: { path } });
}

function commit(root: string, message: string, files: Readonly<Record<string, string>>) {
    for (const [repositoryPath, source] of Object.entries(files)) {
        const filePath = path.join(root, repositoryPath);
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, source);
    }
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '--quiet', '-m', message]);
    return runGit(root, ['rev-parse', 'HEAD']).trim();
}

function runGit(root: string, arguments_: readonly string[]) {
    return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' });
}
