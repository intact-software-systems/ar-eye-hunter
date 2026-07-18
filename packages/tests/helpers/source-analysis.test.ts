import {
    mkdtempSync,
    mkdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    analyzeSource,
    buildRelativeTypeScriptGraph,
    findDependencyCycles,
    resolveRelativeTypeScriptDependency,
} from './source-analysis';

const fixtureDirectories: string[] = [];

afterEach(() => {
    for (const directory of fixtureDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('source analysis', () => {
    it('normalizes TypeScript and TSX module syntax without exposing parser nodes', () => {
        const analysis = analyzeSource(
            `
                import DefaultThing, { type Config, runtime as renamed } from './mixed';
                import type * as Types from './types';
                import './side-effect';
                export { type PublicType, runtimeValue as publicValue } from './public';
                export * from './star';
                export * as namespaceExport from './namespace';
                export interface PublicInterface {}
                export const publicConstant = localStorage;
                export default function publicDefault() {
                    return <DefaultThing value={renamed} />;
                }
                const lazyLiteral = import('./lazy');
                const lazyExpression = import(target);
            `,
            'fixtures/source.tsx',
        );

        expect(analysis.imports).toContainEqual({
            specifier: './mixed',
            typeOnly: false,
            sideEffectOnly: false,
            defaultImport: 'DefaultThing',
            namespaceImport: undefined,
            namedImports: [
                { imported: 'Config', local: 'Config', typeOnly: true },
                { imported: 'runtime', local: 'renamed', typeOnly: false },
            ],
        });
        expect(analysis.imports).toContainEqual({
            specifier: './types',
            typeOnly: true,
            sideEffectOnly: false,
            defaultImport: undefined,
            namespaceImport: 'Types',
            namedImports: [],
        });
        expect(analysis.imports).toContainEqual({
            specifier: './side-effect',
            typeOnly: false,
            sideEffectOnly: true,
            defaultImport: undefined,
            namespaceImport: undefined,
            namedImports: [],
        });
        expect(analysis.exports).toEqual(
            expect.arrayContaining([
                {
                    kind: 'named',
                    exportedName: 'PublicType',
                    localName: 'PublicType',
                    specifier: './public',
                    typeOnly: true,
                },
                {
                    kind: 'named',
                    exportedName: 'publicValue',
                    localName: 'runtimeValue',
                    specifier: './public',
                    typeOnly: false,
                },
                {
                    kind: 'star',
                    specifier: './star',
                    typeOnly: false,
                },
                {
                    kind: 'namespace',
                    exportedName: 'namespaceExport',
                    specifier: './namespace',
                    typeOnly: false,
                },
                {
                    kind: 'declaration',
                    exportedName: 'PublicInterface',
                    localName: 'PublicInterface',
                    typeOnly: true,
                },
                {
                    kind: 'declaration',
                    exportedName: 'publicConstant',
                    localName: 'publicConstant',
                    typeOnly: false,
                },
                {
                    kind: 'default',
                    exportedName: 'default',
                    localName: 'publicDefault',
                    typeOnly: false,
                },
            ]),
        );
        expect(analysis.dynamicImports).toEqual([
            { specifier: './lazy', literal: true },
            { specifier: undefined, literal: false },
        ]);
        expect(analysis.topLevelDeclarations).toEqual(
            expect.arrayContaining([
                {
                    name: 'PublicInterface',
                    kind: 'type',
                    exported: true,
                    defaultExport: false,
                },
                {
                    name: 'publicConstant',
                    kind: 'value',
                    exported: true,
                    defaultExport: false,
                },
                {
                    name: 'publicDefault',
                    kind: 'value',
                    exported: true,
                    defaultExport: true,
                },
                {
                    name: 'lazyLiteral',
                    kind: 'value',
                    exported: false,
                    defaultExport: false,
                },
            ]),
        );
        expect(analysis.identifierNames).toContain('localStorage');
    });

    it('includes the source path in parse failures', () => {
        expect(() => analyzeSource('export const =', 'broken/example.ts')).toThrow(
            /broken\/example\.ts/,
        );
    });

    it('resolves relative TypeScript modules and index modules', () => {
        const directory = createFixtureDirectory();
        const importerPath = writeFixture(directory, 'entry.ts', 'export {};');
        const dependencyPath = writeFixture(
            directory,
            'dependency.tsx',
            'export const dependency = <div />;',
        );
        const indexPath = writeFixture(
            directory,
            'folder/index.ts',
            'export const index = true;',
        );

        expect(
            resolveRelativeTypeScriptDependency(importerPath, './dependency'),
        ).toBe(dependencyPath);
        expect(resolveRelativeTypeScriptDependency(importerPath, './folder')).toBe(
            indexPath,
        );
        expect(
            resolveRelativeTypeScriptDependency(importerPath, '@scope/package'),
        ).toBeUndefined();
        expect(
            resolveRelativeTypeScriptDependency(importerPath, './asset.css'),
        ).toBeUndefined();
    });

    it('builds reachable static graphs and reports deterministic cycles', () => {
        const directory = createFixtureDirectory();
        const entryPath = writeFixture(
            directory,
            'entry.ts',
            `import './acyclic'; export { value } from './cycle-a';`,
        );
        const acyclicPath = writeFixture(
            directory,
            'acyclic.ts',
            `const lazy = import('./not-followed'); export { lazy };`,
        );
        const cycleAPath = writeFixture(
            directory,
            'cycle-a.ts',
            `import { valueB } from './cycle-b'; export const value = valueB;`,
        );
        const cycleBPath = writeFixture(
            directory,
            'cycle-b.ts',
            `import { value } from './cycle-a'; export const valueB = value;`,
        );
        writeFixture(
            directory,
            'not-followed.ts',
            `export const dynamicOnly = true;`,
        );

        const graph = buildRelativeTypeScriptGraph([entryPath]);

        expect([...graph.keys()].sort()).toEqual(
            [entryPath, acyclicPath, cycleAPath, cycleBPath].sort(),
        );
        expect(findDependencyCycles(graph)).toEqual([
            [cycleAPath, cycleBPath, cycleAPath],
        ]);
    });
});

function createFixtureDirectory(): string {
    const directory = mkdtempSync(
        path.join(tmpdir(), 'rallar-source-analysis-'),
    );
    fixtureDirectories.push(directory);
    return directory;
}

function writeFixture(
    rootDirectory: string,
    relativePath: string,
    source: string,
): string {
    const filePath = path.join(rootDirectory, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, source);
    return filePath;
}
