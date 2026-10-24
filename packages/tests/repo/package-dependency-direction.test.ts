import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { buildSync } from 'esbuild';
import {
    describe,
    expect,
    it
} from 'vitest';

const repoRoot = process.cwd();

// Runtime-agnostic packages stay below the browser and server halves.
// Explicit runtime boundaries may add dependencies without exposing them through the pure entry.
const PACKAGE_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
    shared: [],
    'shared-graph': ['shared'],
    'shared-web': ['shared', 'shared-graph'],
    'shared-server': ['shared', 'shared-graph'],
    'shared-test': ['shared', 'shared-graph', 'shared-web', 'shared-server'],
    'relic-hunters': ['shared']
};

const SOURCE_BOUNDARY_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
    'packages/relic-hunters/server/': ['shared-server']
};

const ALIAS_BY_PACKAGE: Readonly<Record<string, string>> = {
    shared: '@shared',
    'shared-graph': '@shared-graph',
    'shared-web': '@shared-web',
    'shared-server': '@shared-server',
    'shared-test': '@shared-test',
    'relic-hunters': '@relic-hunters'
};

interface TypeScriptConfig {
    compilerOptions?: { paths?: Record<string, string[]>; };
}

function readSourceFiles(directory: string): string[] {
    const entries = readdirSync(path.join(repoRoot, directory), { withFileTypes: true });
    return entries.flatMap((entry) => {
        const entryPath = `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
            return entry.name === 'node_modules' ? [] : readSourceFiles(entryPath);
        }
        return /\.(ts|tsx|mts)$/u.test(entry.name) ? [entryPath] : [];
    });
}

function readImportedAliases(filePath: string): readonly string[] {
    const source = readFileSync(path.join(repoRoot, filePath), 'utf8');
    return [...source.matchAll(/from\s+'(@[\w-]+)\//gu)].map((match) => match[1]);
}

function toAllowedAliases(packageName: string, filePath: string): ReadonlySet<string> {
    const sourceDependencies = Object.entries(SOURCE_BOUNDARY_DEPENDENCIES)
        .filter(([boundary]) => filePath.startsWith(boundary))
        .flatMap(([, dependencies]) => dependencies);
    const allowed = [...PACKAGE_DEPENDENCIES[packageName], ...sourceDependencies];
    return new Set([ALIAS_BY_PACKAGE[packageName], ...allowed.map((name) => ALIAS_BY_PACKAGE[name])]);
}

// tsconfig paths must cover everything the project compiles, which includes the transitive closure
// of its dependencies -- shared-test compiles shared-server sources, so it needs shared-graph even
// though it imports none itself. The import rule above is the layering invariant; this is its floor.
function toClosure(packageName: string, seen: Set<string> = new Set()): ReadonlySet<string> {
    for (const dependency of PACKAGE_DEPENDENCIES[packageName] ?? []) {
        if (seen.has(dependency)) {
            continue;
        }
        seen.add(dependency);
        toClosure(dependency, seen);
    }
    return seen;
}

describe('package dependency direction', () => {
    it.each(Object.keys(PACKAGE_DEPENDENCIES))(
        'keeps every %s import inside its declared dependencies',
        (packageName) => {
            const violations = readSourceFiles(`packages/${packageName}`).flatMap((filePath) =>
                readImportedAliases(filePath)
                    .filter((alias) => Object.values(ALIAS_BY_PACKAGE).includes(alias))
                    .filter((alias) => !toAllowedAliases(packageName, filePath).has(alias))
                    .map((alias) => `${filePath} imports ${alias}`)
            );

            expect([...new Set(violations)].toSorted()).toEqual([]);
        }
    );

    it.each(Object.keys(PACKAGE_DEPENDENCIES))(
        'declares no %s tsconfig path outside its dependency closure',
        (packageName) => {
            const config = JSON.parse(
                readFileSync(path.join(repoRoot, `packages/${packageName}/tsconfig.json`), 'utf8')
            ) as TypeScriptConfig;
            const permitted = new Set([
                ALIAS_BY_PACKAGE[packageName],
                ...[...toClosure(packageName)].map((name) => ALIAS_BY_PACKAGE[name])
            ]);
            const declared = Object.keys(config.compilerOptions?.paths ?? {}).map((mapping) => mapping.replace(/\/\*$/u, ''));

            expect(declared.filter((alias) => !permitted.has(alias)).toSorted()).toEqual([]);
        }
    );

    it.each(['packages/relic-hunters/mod.ts', ...readSourceFiles('packages/relic-hunters/src')])(
        'bundles %s for browsers without server runtime code',
        (entry) => {
            const bundle = buildSync({
                absWorkingDir: repoRoot,
                entryPoints: [entry],
                bundle: true,
                platform: 'browser',
                format: 'esm',
                target: 'es2022',
                tsconfig: 'tsconfig.json',
                treeShaking: false,
                write: false,
                metafile: true
            });
            const serverInputs = Object.keys(bundle.metafile.inputs).filter((filePath) =>
                filePath.startsWith('packages/relic-hunters/server/') ||
                filePath.startsWith('packages/shared-server/')
            );

            expect(serverInputs).toEqual([]);
        }
    );

    it('keeps the api-v1 Deno import map free of browser and test-only packages', () => {
        const imports = (
            JSON.parse(readFileSync(path.join(repoRoot, 'apps/api-v1/deno.json'), 'utf8')) as {
                imports?: Record<string, string>;
            }
        ).imports;
        const declared = Object.keys(imports ?? {});

        expect(declared).not.toContain('@shared-web/');
        expect(declared).not.toContain('@shared-test/');
    });

    // packages/shared-test ships products (the black-box runner); packages/tests is test code only.
    // A test may use either, but application source may reach neither.
    it('keeps api-v1 application source free of test code and test products', () => {
        const offenders = readSourceFiles('apps/api-v1/src')
            .filter((filePath) => {
                const source = readFileSync(path.join(repoRoot, filePath), 'utf8');
                return source.includes('packages/shared-test') || source.includes('packages/tests');
            })
            .toSorted();

        expect(offenders).toEqual([]);
    });
});
