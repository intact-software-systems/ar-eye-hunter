import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test } from 'vitest';

// Owner: Recipe Console Fleet. Supplementary architecture guard; remove when the built-bundle
// dependency check enforces Fleet's network/state ownership and local CSS boundaries.
const repositoryRoot = resolve(import.meta.dirname, '../../..');
const fleetRoot = 'apps/rallar-black-box/src/recipe-console/fleet';

function source(path: string): string {
    return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

function filesBelow(path: string): string[] {
    return readdirSync(resolve(repositoryRoot, path), { recursive: true, encoding: 'utf8' })
        .map((entry) => `${path}/${entry}`);
}

function importedSpecifiers(file: string): string[] {
    return [...file.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g)]
        .map((match) => match[1] ?? match[2] ?? match[3]);
}

test('keeps Fleet isolated from legacy, duplicate I/O, global state, and global CSS', () => {
    const owners = filesBelow(fleetRoot)
        .filter((path) => /\.(?:ts|tsx|css)$/.test(path))
        .sort();
    const ownerSources = owners
        .filter((path) => /\.tsx?$/.test(path))
        .map((path) => [path, source(path)] as const);
    const allSources = ownerSources.map(([, file]) => file).join('\n');

    expect(allSources).not.toMatch(
        /(?:from\s+|import\()['"][^'"]*legacy\/|\bfetch\s*\(|\bsetInterval\s*\(|\bsetTimeout\s*\(|\buseRecipeConsoleControlWorkspace\b|\buseControlConnection\b|\bcreateContext\b|\blocalStorage\b|\bsessionStorage\b|\b(?:manualToken|controlToken|controlUrl)\b/
    );
    const cssImports = ownerSources.flatMap(([path, file]) =>
        importedSpecifiers(file)
            .filter((specifier) => specifier.endsWith('.css'))
            .map((specifier) => ({ path, specifier }))
    );
    expect(cssImports.length).toBeGreaterThan(0);
    for (const { path, specifier } of cssImports) {
        expect(specifier, path).toMatch(/^\.\/.+\.module\.css$/);
        expect(
            resolve(repositoryRoot, dirname(path), specifier).startsWith(
                resolve(repositoryRoot, fleetRoot)
            ),
            `${path}: ${specifier}`
        ).toBe(true);
    }
    expect(
        owners.filter((path) => path.endsWith('.css')).every(
            (path) => path.endsWith('.module.css')
        )
    ).toBe(true);
});
