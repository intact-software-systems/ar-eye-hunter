import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { buildSync } from 'esbuild';
import {
    describe,
    expect,
    it
} from 'vitest';

import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';

import { analyzeSourceFile } from '../helpers/source-analysis.ts';

const repoRoot = process.cwd();

// Runtime-agnostic packages stay below the browser and server halves.
// Explicit runtime boundaries may add dependencies without exposing them through the pure entry.
const PACKAGE_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
    shared: [],
    'shared-graph': ['shared'],
    'shared-web': ['shared', 'shared-graph'],
    'shared-react': ['shared', 'shared-web'],
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
    'shared-react': '@shared-react',
    'shared-server': '@shared-server',
    'shared-test': '@shared-test',
    'relic-hunters': '@relic-hunters'
};

function readSourceFiles(directory: string): string[] {
    const entries = readdirSync(path.join(repoRoot, directory), { withFileTypes: true });
    return entries.flatMap((entry) => {
        const entryPath = `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
            return entry.name === 'node_modules' ? [] : readSourceFiles(entryPath);
        }
        return /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(entry.name) ? [entryPath] : [];
    });
}

function readImportedAliases(filePath: string): readonly string[] {
    return readImportedSpecifiers(filePath).flatMap((specifier) => {
        const alias = /^(@[\w-]+)\//u.exec(specifier)?.[1];
        return alias ? [alias] : [];
    });
}

function readImportedSpecifiers(filePath: string): readonly string[] {
    const analysis = analyzeSourceFile(path.join(repoRoot, filePath));
    return [
        ...analysis.imports.map((entry) => entry.specifier),
        ...analysis.exports.flatMap((entry) => entry.specifier ? [entry.specifier] : []),
        ...analysis.dynamicImports.flatMap((entry) => entry.specifier ? [entry.specifier] : [])
    ];
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
    it.each(['shared', 'shared-web', 'shared-test', 'shared-server', 'shared-graph'])(
        'keeps %s independent of React and shared-react',
        (packageName) => {
            const root = `packages/${packageName}`;
            const files = readSourceFiles(root);
            const jsxSources = files.filter((filePath) => /\.[jt]sx$/u.test(filePath));
            const imports = files.flatMap((filePath) =>
                readImportedSpecifiers(filePath)
                    .filter((specifier) =>
                        /^(?:npm:)?(?:react(?:[-/]|$)|@types\/react|@shared-react(?:\/|$)|@ar-eye-hunter\/shared-react)/u
                            .test(specifier) ||
                        specifier.startsWith('.') &&
                            path.resolve(repoRoot, path.dirname(filePath), specifier)
                                .startsWith(path.join(repoRoot, 'packages/shared-react') + path.sep)
                    )
                    .map((specifier) => `${filePath} imports ${specifier}`)
            );
            const manifest = existsSync(path.join(repoRoot, root, 'package.json'))
                ? readJsonObject(`${root}/package.json`)
                : {};
            const dependencies = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
                .flatMap((field) => Object.keys(requireObject(manifest[field] ?? {})))
                .filter((name) => /^(?:react(?:-|$)|@types\/react|@ar-eye-hunter\/shared-react)/u.test(name));

            expect({ imports, dependencies, jsxSources }).toEqual({ imports: [], dependencies: [], jsxSources: [] });
        }
    );

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
            const config = readJsonObject(`packages/${packageName}/tsconfig.json`);
            const compilerOptions = requireObject(config.compilerOptions);
            const paths = requireObject(compilerOptions.paths);
            const permitted = new Set([
                ALIAS_BY_PACKAGE[packageName],
                ...[...toClosure(packageName)].map((name) => ALIAS_BY_PACKAGE[name])
            ]);
            const declared = Object.keys(paths).map((mapping) => mapping.replace(/\/\*$/u, ''));

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
        const imports = requireObject(readJsonObject('apps/api-v1/deno.json').imports);
        const declared = Object.keys(imports);

        expect(declared).not.toContain('@shared-web/');
        expect(declared).not.toContain('@shared-react/');
        expect(declared).not.toContain('@shared-test/');
        expect(declared).not.toContain('@relic-hunters/');
    });

    it('resolves the actual API entrypoint without consumer game or React modules', () => {
        const graph = requireObject(JSON.parse(execFileSync('deno', [
            'info',
            '--json',
            '--config',
            'apps/api-v1/deno.json',
            'apps/api-v1/src/main.ts'
        ], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })));
        if (!Array.isArray(graph.modules)) {
            throw new TypeError('Deno module graph must contain its resolved module inventory');
        }
        const modules = graph.modules.map((entry) => {
            const specifier = requireObject(entry).specifier;
            if (typeof specifier !== 'string') {
                throw new TypeError('Deno module graph entry must name its resolved specifier');
            }
            return specifier;
        });
        expect(modules.some((specifier) => specifier.endsWith('/apps/api-v1/src/main.ts'))).toBe(true);
        expect(modules.filter((specifier) => /(?:\/packages\/shared-react\/|(?:npm:|\/node_modules\/)react(?:@|\/|-))/u.test(specifier))).toEqual([]);
        expect(modules.filter((specifier) => /\/(?:packages|apps)\/relic[^/]*\//u.test(specifier))).toEqual([]);
    }, 30_000);

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

function readJsonObject(filePath: string): ApiJsonObject {
    return requireObject(JSON.parse(readFileSync(path.join(repoRoot, filePath), 'utf8')));
}

function requireObject(value: ApiJsonValue): ApiJsonObject {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError('Expected a configuration or module graph object');
    }
    return value as ApiJsonObject;
}
