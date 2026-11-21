import { execFileSync } from 'node:child_process';
import {
    mkdtempSync,
    readFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it
} from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');
const commandPath = path.join(repoRoot, 'scripts/alm-lane-selection.mjs');

interface CommandRun {
    output: string;
    githubOutput: string;
}

function runCommand(changedPaths: string): CommandRun {
    const githubOutputPath = path.join(mkdtempSync(path.join(tmpdir(), 'alm-lane-selection-')), 'github-output');
    const output = execFileSync(process.execPath, [commandPath], {
        input: changedPaths,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: githubOutputPath }
    });
    return { output, githubOutput: readFileSync(githubOutputPath, 'utf8') };
}

describe('ALM lane selection command', () => {
    it('writes run_full_scope=false when every changed path cannot change the lane', () => {
        const result = runCommand('docs/a.md\n');

        expect(result.githubOutput).toBe('run_full_scope=false\n');
        expect(result.output).toBe('SKIPPED: every changed path cannot change the ALM lane\n');
    });

    it('writes run_full_scope=true and names the deciding path', () => {
        const result = runCommand('packages/shared/alm/a.ts\n');

        expect(result.githubOutput).toBe('run_full_scope=true\n');
        expect(result.output).toBe('SELECTED: full ALM scope for packages/shared/alm/a.ts\n');
    });

    it('ignores a blank trailing line', () => {
        expect(runCommand('docs/a.md\n\n').githubOutput).toBe('run_full_scope=false\n');
    });
});
