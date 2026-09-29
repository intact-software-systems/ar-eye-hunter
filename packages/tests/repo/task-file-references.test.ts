import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface TaskManifest {
    readonly scripts?: Readonly<Record<string, string>>;
    readonly tasks?: Readonly<Record<string, string | { readonly command?: string; }>>;
}

const repoRoot = path.resolve(__dirname, '../../..');
const manifestPaths = [
    'package.json',
    'packages/shared-test/package.json',
    'deno.json',
    'apps/api-v1/deno.json',
    'apps/rallar-black-box-control-server/deno.json',
    'apps/relic-hunter-server-v1/deno.json'
] as const;
const repositoryPath = /^(?:packages|apps|tests|scripts|docs|examples|\.github)\/[\w./@-]+$/u;

describe('task file references', () => {
    it.each(manifestPaths)('%s names only files and directories that exist', (manifestPath) => {
        const manifest = JSON.parse(readFileSync(path.join(repoRoot, manifestPath), 'utf8')) as TaskManifest;
        const manifestDirectory = path.dirname(path.join(repoRoot, manifestPath));
        const missing = Object.entries({ ...manifest.scripts, ...manifest.tasks })
            .flatMap(([name, task]) => toCommandPaths(typeof task === 'string' ? task : task.command ?? '').map((file) => ({ name, file })))
            .filter(({ file }) => !existsSync(path.join(repoRoot, file)) && !existsSync(path.join(manifestDirectory, file)))
            .map(({ name, file }) => `${name} -> ${file}`);

        expect(missing).toEqual([]);
    });
});

// `vitest run <path>` treats a path as a filter, so a deleted test file silently drops out of a script.
function toCommandPaths(command: string): string[] {
    return command
        .split(/\s+/u)
        .map((token) => token.replaceAll(/^["']|["']$/gu, ''))
        .filter((token) => repositoryPath.test(token) && !token.includes('*'));
}
