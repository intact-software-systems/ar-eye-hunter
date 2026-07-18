import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(__dirname, '../../..');
const expectedTypeScriptVersion = '7.0.2';
const ignoredDirectoryNames = new Set([
    '.deno',
    '.git',
    '.pnpm-store',
    'coverage',
    'dist',
    'node_modules',
    'playwright-report',
    'test-results',
    'tmp',
]);

type DependencyMap = Record<string, string>;

interface PackageManifest {
    dependencies?: DependencyMap;
    devDependencies?: DependencyMap;
    optionalDependencies?: DependencyMap;
    peerDependencies?: DependencyMap;
    scripts?: Record<string, string>;
}

interface TypeScriptConfig {
    compilerOptions?: {
        baseUrl?: unknown;
        ignoreDeprecations?: unknown;
        paths?: Record<string, string[]>;
        skipLibCheck?: unknown;
        types?: unknown;
    };
}

describe('native TypeScript 7 repository boundaries', () => {
    it('pins every declared TypeScript compiler to 7.0.2 without compatibility packages', () => {
        const declarations = findFiles(repositoryRoot, 'package.json').flatMap(
            (manifestPath) => {
                const manifest = readJson<PackageManifest>(manifestPath);

                return dependencySections(manifest).flatMap(
                    ([section, dependencies]) =>
                        Object.entries(dependencies).map(
                            ([dependency, version]) => ({
                                dependency,
                                manifest: relativePath(manifestPath),
                                section,
                                version,
                            }),
                        ),
                );
            },
        );

        expect(
            declarations.filter(
                ({ dependency, version }) =>
                    dependency === '@typescript/typescript6' ||
                    version.includes('@typescript/typescript6') ||
                    /^npm:typescript@(?:\D*)?[56](?:\.|$)/.test(version),
            ),
        ).toEqual([]);

        expect(
            declarations.filter(
                ({ dependency }) => dependency === 'typescript',
            ),
        ).toEqual([
            {
                dependency: 'typescript',
                manifest: 'apps/ar-eye-hunter-v1/package.json',
                section: 'devDependencies',
                version: expectedTypeScriptVersion,
            },
            {
                dependency: 'typescript',
                manifest: 'apps/rallar-black-box/package.json',
                section: 'devDependencies',
                version: expectedTypeScriptVersion,
            },
            {
                dependency: 'typescript',
                manifest: 'apps/rallar-black-box-headless/package.json',
                section: 'devDependencies',
                version: expectedTypeScriptVersion,
            },
            {
                dependency: 'typescript',
                manifest: 'apps/relic-hunters-v1/package.json',
                section: 'devDependencies',
                version: expectedTypeScriptVersion,
            },
            {
                dependency: 'typescript',
                manifest: 'package.json',
                section: 'devDependencies',
                version: expectedTypeScriptVersion,
            },
        ]);
    });

    it('uses only TS7-compatible npm TypeScript configurations', () => {
        const denoOnlyConfigs = [
            'apps/api-v1/tsconfig.json',
            'apps/rallar-black-box-control-server/tsconfig.json',
            'apps/relic-hunter-server-v1/tsconfig.json',
        ];

        expect(
            denoOnlyConfigs.filter((configPath) =>
                existsSync(path.join(repositoryRoot, configPath)),
            ),
        ).toEqual([]);

        const configProblems = findTypeScriptConfigs().flatMap((configPath) => {
            const config = readJson<TypeScriptConfig>(configPath);
            const compilerOptions = config.compilerOptions ?? {};
            const problems: string[] = [];

            if ('baseUrl' in compilerOptions) {
                problems.push('declares removed compiler option baseUrl');
            }

            if ('ignoreDeprecations' in compilerOptions) {
                problems.push('declares forbidden ignoreDeprecations fallback');
            }

            if (compilerOptions.skipLibCheck === true) {
                problems.push('enables forbidden skipLibCheck suppression');
            }

            if (!Array.isArray(compilerOptions.types)) {
                problems.push('does not declare ambient types explicitly');
            }

            for (const [mapping, substitutions] of Object.entries(
                compilerOptions.paths ?? {},
            )) {
                for (const substitution of substitutions) {
                    if (
                        !substitution.startsWith('./') &&
                        !substitution.startsWith('../')
                    ) {
                        problems.push(
                            `maps ${mapping} to non-relative substitution ${substitution}`,
                        );
                    }
                }
            }

            return problems.map(
                (problem) => `${relativePath(configPath)}: ${problem}`,
            );
        });

        expect(configProblems).toEqual([]);
    });

    it('does not import TypeScript compiler APIs', () => {
        const compilerApiImport =
            /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](?:typescript|@typescript\/typescript6)(?:\/[^'"]*)?['"]/;
        const sourceExtensions = new Set([
            '.cjs',
            '.cts',
            '.js',
            '.jsx',
            '.mjs',
            '.mts',
            '.ts',
            '.tsx',
        ]);
        const importedBy = findSourceFiles(repositoryRoot, sourceExtensions)
            .filter((sourcePath) =>
                compilerApiImport.test(readFileSync(sourcePath, 'utf8')),
            )
            .map(relativePath);

        expect(importedBy).toEqual([]);
    });

    it('keeps TypeScript and Deno checking as separate release gates', () => {
        const sharedTestManifest = readJson<PackageManifest>(
            path.join(repositoryRoot, 'packages/shared-test/package.json'),
        );
        const releaseGate = readFileSync(
            path.join(repositoryRoot, '.github/workflows/release-gate.yml'),
            'utf8',
        );

        expect(sharedTestManifest.scripts?.typecheck).toBe('npm run check:ts');
        expect(releaseGate).toContain(
            'npm --workspace @ar-eye-hunter/shared-test run check:deno',
        );
    });
});

function dependencySections(
    manifest: PackageManifest,
): Array<[string, DependencyMap]> {
    return [
        ['dependencies', manifest.dependencies ?? {}],
        ['devDependencies', manifest.devDependencies ?? {}],
        ['optionalDependencies', manifest.optionalDependencies ?? {}],
        ['peerDependencies', manifest.peerDependencies ?? {}],
    ];
}

function findFiles(directory: string, fileName: string): string[] {
    return findFilesMatching(directory, (entry) => entry === fileName);
}

function findFilesMatching(
    directory: string,
    matches: (entry: string) => boolean,
): string[] {
    if (!existsSync(directory)) {
        return [];
    }

    return readdirSync(directory)
        .sort()
        .flatMap((entry) => {
            const entryPath = path.join(directory, entry);

            if (statSync(entryPath).isDirectory()) {
                return ignoredDirectoryNames.has(entry)
                    ? []
                    : findFilesMatching(entryPath, matches);
            }

            return matches(entry) ? [entryPath] : [];
        });
}

function findSourceFiles(
    directory: string,
    extensions: ReadonlySet<string>,
): string[] {
    if (!existsSync(directory)) {
        return [];
    }

    return readdirSync(directory)
        .sort()
        .flatMap((entry) => {
            const entryPath = path.join(directory, entry);

            if (statSync(entryPath).isDirectory()) {
                return ignoredDirectoryNames.has(entry)
                    ? []
                    : findSourceFiles(entryPath, extensions);
            }

            return extensions.has(path.extname(entryPath)) ? [entryPath] : [];
        });
}

function findTypeScriptConfigs(): string[] {
    return findFilesMatching(repositoryRoot, (entry) =>
        /^tsconfig(?:\..+)?\.json$/.test(entry),
    );
}

function readJson<T>(filePath: string): T {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function relativePath(filePath: string): string {
    return path.relative(repositoryRoot, filePath).replaceAll(path.sep, '/');
}
