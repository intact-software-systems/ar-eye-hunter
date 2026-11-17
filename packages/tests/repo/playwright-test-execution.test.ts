import { spawnSync } from 'node:child_process';
import {
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

interface PlaywrightFixture {
    readonly root: string;
    readonly spec: string;
    readonly listed: string;
    readonly executed: string;
}

interface NativeReportSelection {
    readonly list: boolean;
    readonly arguments: readonly string[];
}

const repositoryRoot = process.cwd();
const checker = path.join(repositoryRoot, 'scripts/check-test-reachability.mjs');
const playwright = path.join(repositoryRoot, 'node_modules/playwright/cli.js');
const fixtureRoots: string[] = [];

afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('Playwright execution reachability through native reports', { timeout: 35_000 }, () => {
    it('accepts a listed test only after its assertion actually passes', () => {
        const fixture = createFixture('test(\'live proof\', () => expect(2 + 2).toBe(4));');
        writeNativeReport(fixture, { list: false, arguments: [] });

        const result = runCheck(fixture);

        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain('1 listed cases, 0 without a passing execution');
    });

    it.each([
        ['declared skip', 'test.skip(\'live proof\', () => {});'],
        ['runtime environment skip', 'test(\'live proof\', () => { test.skip(process.env.LIVE_PROOF !== \'1\'); });'],
        ['fixme', 'test.fixme(\'live proof\', () => {});'],
        ['mixed executed and skipped cases', 'test(\'ordinary proof\', () => {}); test(\'live proof\', () => test.skip());']
    ])('rejects %s even though the native listing includes the file', (_name, source) => {
        const fixture = createFixture(source);
        writeNativeReport(fixture, { list: false, arguments: [] });

        const result = runCheck(fixture);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('live proof');
        expect(result.stderr).toContain('listed but skipped, missing, or failed at runtime');
    });

    it('rejects a runtime filter that omits one of the listed cases', () => {
        const fixture = createFixture('test(\'ordinary proof\', () => {}); test(\'live proof\', () => {});');
        writeNativeReport(fixture, { list: false, arguments: ['--grep', 'ordinary proof'] });

        const result = runCheck(fixture);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('live proof');
        expect(result.stderr).not.toContain('ordinary proof');
    });

    it('does not accept a list-only report as runtime execution', () => {
        const fixture = createFixture('test(\'live proof\', () => {});');

        const result = runCheck({ ...fixture, executed: fixture.listed });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('live proof');
    });

    it('requires the named suite to be present, so omitting it cannot produce a green empty proof', () => {
        const fixture = createFixture('test(\'ordinary proof\', () => {});');
        writeNativeReport(fixture, { list: false, arguments: [] });

        const result = runCheck({ ...fixture, spec: path.join(fixture.root, 'missing.spec.ts') });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('missing.spec.ts: required file was not listed');
    });

    it('fails closed on a malformed execution report', () => {
        const fixture = createFixture('test(\'live proof\', () => {});');
        writeFileSync(fixture.executed, JSON.stringify({ suites: [] }));

        const result = runCheck(fixture);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('not a native Playwright JSON report');
    });

    it('rejects an empty native selection even when Playwright permits no tests', () => {
        const fixture = createFixture('test(\'live proof\', () => {});');
        const selection = ['--grep', 'no matching case', '--pass-with-no-tests'];
        writeNativeReport(fixture, { list: true, arguments: selection });
        writeNativeReport(fixture, { list: false, arguments: selection });

        const result = runCheck(fixture);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('No test cases were listed');
    });

    it('does not let one passing project cover a skipped project', () => {
        const fixture = createFixture('test(\'live proof\', ({}, info) => test.skip(info.project.name === \'second\'));');
        writeFileSync(
            path.join(fixture.root, 'playwright.config.mjs'),
            'export default { testDir: ".", workers: 1, retries: 0, projects: [{name:"first"},{name:"second"}] };'
        );
        writeNativeReport(fixture, { list: true, arguments: [] });
        writeNativeReport(fixture, { list: false, arguments: [] });

        const result = runCheck(fixture);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('[second]');
        expect(result.stderr).not.toContain('[first]');
    });
});

function createFixture(source: string): PlaywrightFixture {
    const root = mkdtempSync(path.join(tmpdir(), 'rallar-playwright-execution-'));
    fixtureRoots.push(root);
    symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    const fixture = {
        root,
        spec: path.join(root, 'behavior.spec.ts'),
        listed: path.join(root, 'listed.json'),
        executed: path.join(root, 'executed.json')
    };
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(path.join(root, 'playwright.config.mjs'), 'export default { testDir: ".", workers: 1, retries: 0 };');
    writeFileSync(fixture.spec, `import { test, expect } from '@playwright/test';\n${source}\n`);
    writeNativeReport(fixture, { list: true, arguments: [] });
    return fixture;
}

function writeNativeReport(fixture: PlaywrightFixture, selection: NativeReportSelection): void {
    const result = spawnSync(process.execPath, [
        playwright,
        'test',
        '--config',
        'playwright.config.mjs',
        '--reporter=json',
        ...(selection.list ? ['--list'] : []),
        ...selection.arguments
    ], {
        cwd: fixture.root,
        env: { ...process.env, LIVE_PROOF: '0', PLAYWRIGHT_JSON_OUTPUT_FILE: '', PLAYWRIGHT_JSON_OUTPUT_NAME: '' },
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    writeFileSync(selection.list ? fixture.listed : fixture.executed, result.stdout);
}

function runCheck(fixture: PlaywrightFixture) {
    return spawnSync(process.execPath, [
        checker,
        '--playwright-execution',
        '--listed',
        fixture.listed,
        '--executed',
        fixture.executed,
        '--require-file',
        fixture.spec
    ], { cwd: repositoryRoot, encoding: 'utf8', timeout: 30_000 });
}
