import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = new URL('../../../', import.meta.url);
const BUN_SERVER_ENTRIES = [
    'apps/api-v1/src/main.ts',
    'apps/ar-eye-hunter-server-v1/src/main.ts',
    'apps/relic-hunter-server-v1/src/main.ts',
    'apps/rallar-black-box-control-server/src/main.ts'
];
const PRINT_VALUE = 'console.log(process.env.RALLAR_ENV_FILE_PROBE ?? "unset")';

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function createEnvDirectory(files: Readonly<Record<string, string>>): string {
    const directory = mkdtempSync(join(tmpdir(), 'rallar-bun-env-'));
    directories.push(directory);
    for (const [name, value] of Object.entries(files)) {
        writeFileSync(join(directory, name), `RALLAR_ENV_FILE_PROBE=${value}\n`);
    }
    return directory;
}

function readProbe(directory: string, flags: readonly string[], injected?: string): string {
    const environment: NodeJS.ProcessEnv = { PATH: process.env['PATH'] };
    if (injected !== undefined) {
        environment['RALLAR_ENV_FILE_PROBE'] = injected;
    }
    const result = spawnSync('bun', [...flags, '--eval', PRINT_VALUE], {
        cwd: directory,
        encoding: 'utf8',
        env: environment
    });
    expect(result.stderr).toBe('');
    return result.stdout.trim();
}

function readRepositoryText(path: string): string {
    return readFileSync(new URL(path, REPO_ROOT), 'utf8');
}

describe('Bun server environment files', () => {
    it('lets the process environment beat every env file', () => {
        const directory = createEnvDirectory({ '.env': 'file', '.env.local': 'local-file' });

        expect(readProbe(directory, [], 'injected')).toBe('injected');
        expect(readProbe(directory, ['--env-file=.env.local', '--env-file=.env'], 'injected')).toBe('injected');
    });

    it('reads the working directory automatically with .env.local over .env', () => {
        const directory = createEnvDirectory({ '.env': 'file', '.env.local': 'local-file' });

        expect(readProbe(directory, [])).toBe('local-file');
    });

    it('lets an explicit --env-file list replace the automatic set, the last listed file winning', () => {
        const directory = createEnvDirectory({ '.env': 'file', 'other.env': 'other', '.env.local': 'local-file' });

        expect(readProbe(directory, ['--env-file=other.env'])).toBe('other');
        expect(readProbe(directory, ['--env-file=other.env', '--env-file=.env'])).toBe('file');
        expect(readProbe(directory, ['--env-file=missing.env', '--env-file=other.env'])).toBe('other');
    });

    it('keeps Bun as the only env-file loader in every Bun server entry', () => {
        const loaders = BUN_SERVER_ENTRIES.filter((entry) => /from 'dotenv|'dotenv\/config'/u.test(readRepositoryText(entry)));

        expect(loaders).toEqual([]);
    });

    it('passes the API-v1 env files, lowest precedence first, to servers started outside apps/api-v1', () => {
        const root = JSON.parse(readRepositoryText('package.json')).scripts;
        const relic = JSON.parse(readRepositoryText('apps/relic-hunter-server-v1/package.json')).scripts;
        const rootApiFiles = '--env-file=.env --env-file=apps/api-v1/.env --env-file=apps/api-v1/.env.local';
        const relicFiles = '--env-file=../api-v1/.env --env-file=../api-v1/.env.local --env-file=.env --env-file=.env.local';

        expect({
            'dev:rallar:api': root['dev:rallar:api'].includes(rootApiFiles),
            'start:rallar:api': root['start:rallar:api'].includes(rootApiFiles),
            'relic start': relic.start.includes(relicFiles),
            'relic dev': relic.dev.includes(relicFiles)
        }).toEqual({ 'dev:rallar:api': true, 'start:rallar:api': true, 'relic start': true, 'relic dev': true });
    });
});
