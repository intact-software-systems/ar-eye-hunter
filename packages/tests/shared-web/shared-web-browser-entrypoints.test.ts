import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    analyzeSourceFile,
    type SourceAnalysis,
    type SourceImport,
} from '../helpers/source-analysis';

type BrowserEntrypoint = Readonly<{
    moduleId: string;
    sourcePath: string;
    expectedRuntimeExports: readonly string[];
    forbiddenRuntimeExports: readonly string[];
}>;

const BROWSER_ENTRYPOINTS: readonly BrowserEntrypoint[] = [
    {
        moduleId: '@shared-web/browser/rallar-core.ts',
        sourcePath: 'packages/shared-web/browser/rallar-core.ts',
        expectedRuntimeExports: [
            'configureApiClient',
            'createRallarAuthFacade',
            'createRallarConnectionFacade',
            'createRallarMessagesFacade',
            'createRallarPeopleFacade',
            'createRallarRoomsFacade',
            'createRallarStatsFacade',
            'matchesRallarMessageSelector',
            'normalizeRallarMessageSelector',
            'normalizeApiBaseUrl',
            'readApiBaseUrl',
        ],
        forbiddenRuntimeExports: [
            'createRallarCrdtFacade',
            'createRallarDataFacade',
            'createRallarFacade',
            'createRallarMediaFacade',
            'createRallarCallsFacade',
            'rallar',
        ],
    },
    {
        moduleId: '@shared-web/browser/rallar-realtime.ts',
        sourcePath: 'packages/shared-web/browser/rallar-realtime.ts',
        expectedRuntimeExports: [
            'configureApiClient',
            'createRallarAuthFacade',
            'createRallarConnectionFacade',
            'createRallarMessagesFacade',
            'createRallarPeopleFacade',
            'createRallarRealtimeFacade',
            'createRallarRoomsFacade',
            'createRallarRtcFacade',
            'createRallarStatsFacade',
            'matchesRallarMessageSelector',
            'normalizeRallarMessageSelector',
            'normalizeApiBaseUrl',
            'readApiBaseUrl',
        ],
        forbiddenRuntimeExports: [
            'createRallarCrdtFacade',
            'createRallarDataFacade',
            'createRallarFacade',
            'createRallarMediaFacade',
            'createRallarCallsFacade',
            'rallar',
        ],
    },
    {
        moduleId: '@shared-web/browser/rallar-media-calls.ts',
        sourcePath: 'packages/shared-web/browser/rallar-media-calls.ts',
        expectedRuntimeExports: [
            'createRallarCallsFacade',
            'createRallarMediaFacade',
        ],
        forbiddenRuntimeExports: [
            'createRallarCrdtFacade',
            'createRallarDataFacade',
            'createRallarFacade',
            'createRallarRealtimeFacade',
            'createRallarRtcFacade',
            'rallar',
        ],
    },
];

const PUBLIC_FACADE_MODULES = [
    'packages/shared-web/browser/rallar-auth-facade.ts',
    'packages/shared-web/browser/rallar-calls-facade.ts',
    'packages/shared-web/browser/rallar-connection-facade.ts',
    'packages/shared-web/browser/rallar-director-facade.ts',
    'packages/shared-web/browser/rallar-media-facade.ts',
    'packages/shared-web/browser/rallar-messages-facade.ts',
    'packages/shared-web/browser/rallar-people-facade.ts',
    'packages/shared-web/browser/rallar-realtime-facade.ts',
    'packages/shared-web/browser/rallar-rooms-facade.ts',
    'packages/shared-web/browser/rooms/rallar-room-contracts.ts',
    'packages/shared-web/browser/rooms/rallar-rooms-facade.ts',
    'packages/shared-web/browser/rallar-rtc-facade.ts',
    'packages/shared-web/browser/rallar-stats-facade.ts',
] as const;

describe('shared-web browser entrypoints', () => {
    for (const entrypoint of BROWSER_ENTRYPOINTS) {
        it(`exposes the intended runtime exports from ${entrypoint.moduleId}`, async () => {
            const module = await import(entrypoint.moduleId);

            for (const exportName of entrypoint.expectedRuntimeExports) {
                expect(module[exportName], exportName).toBeTypeOf('function');
            }

            for (const exportName of entrypoint.forbiddenRuntimeExports) {
                expect(module, exportName).not.toHaveProperty(exportName);
            }
        });

        it(`does not runtime-import the full rallar facade from ${entrypoint.moduleId}`, () => {
            const sourceFile = readSourceAnalysis(entrypoint.sourcePath);

            expect(collectRuntimeFullFacadeReferences(sourceFile)).toEqual([]);
        });
    }

    it('keeps public facade contracts independent from the full facade entrypoint', () => {
        const references = PUBLIC_FACADE_MODULES.flatMap((filePath) =>
            collectFullFacadeReferences(readSourceAnalysis(filePath)).map(
                (reference) => `${filePath}: ${reference}`,
            )
        );

        expect(references).toEqual([]);
    });

    it('keeps public facade contracts independent from the aggregate contract', () => {
        const references = PUBLIC_FACADE_MODULES.flatMap((filePath) =>
            collectModuleReferences(
                readSourceAnalysis(filePath),
                '@shared-web/browser/rallar-facade-contract.ts',
            ).map((reference) => `${filePath}: ${reference}`)
        );

        expect(references).toEqual([]);
    });

    it('keeps runtime controllers independent from the compatibility entrypoint', () => {
        const runtimeFiles = readdirSync(
            path.resolve('packages/shared-web/browser/rallar-runtime'),
        ).filter((fileName) => fileName.endsWith('.ts'));
        const references = runtimeFiles.flatMap((fileName) =>
            collectFullFacadeReferences(readSourceAnalysis(
                `packages/shared-web/browser/rallar-runtime/${fileName}`,
            )).map((reference) => `${fileName}: ${reference}`)
        );

        expect(references).toEqual([]);
    });

    it('keeps runtime controllers independent from the aggregate contract', () => {
        const allowedFiles = new Set(['composition.ts']);
        const runtimeFiles = readdirSync(
            path.resolve('packages/shared-web/browser/rallar-runtime'),
        ).filter((fileName) =>
            fileName.endsWith('.ts') && !allowedFiles.has(fileName)
        );
        const references = runtimeFiles.flatMap((fileName) =>
            collectModuleReferences(
                readSourceAnalysis(
                    `packages/shared-web/browser/rallar-runtime/${fileName}`,
                ),
                '@shared-web/browser/rallar-facade-contract.ts',
            ).map((reference) => `${fileName}: ${reference}`)
        );

        expect(references).toEqual([]);
    });

    it('keeps mutable state-cache access inside the state store', () => {
        const allowedFiles = new Set(['state-store.ts']);
        const runtimeFiles = readdirSync(
            path.resolve('packages/shared-web/browser/rallar-runtime'),
        ).filter((fileName) =>
            fileName.endsWith('.ts') && !allowedFiles.has(fileName)
        );
        const references = runtimeFiles.flatMap((fileName) =>
            collectModuleReferences(
                readSourceAnalysis(
                    `packages/shared-web/browser/rallar-runtime/${fileName}`,
                ),
                '@shared-web/browser/data-caches.ts',
            ).map((reference) => `${fileName}: ${reference}`)
        );

        expect(references).toEqual([]);
    });

    it('limits the full runtime context to the composer and port contracts', () => {
        const allowedFiles = new Set(['composition.ts', 'contracts.ts']);
        const runtimeFiles = readdirSync(
            path.resolve('packages/shared-web/browser/rallar-runtime'),
        ).filter((fileName) =>
            fileName.endsWith('.ts') && !allowedFiles.has(fileName)
        );
        const references = runtimeFiles.flatMap((fileName) =>
            collectModuleReferences(
                readSourceAnalysis(
                    `packages/shared-web/browser/rallar-runtime/${fileName}`,
                ),
                '@shared-web/browser/rallar-runtime-context.ts',
            ).map((reference) => `${fileName}: ${reference}`)
        );

        expect(references).toEqual([]);
    });

    it('keeps capability controllers behind injected ports', () => {
        const allowedRuntimeDependencies = new Set([
            'contracts.ts',
            'message-conversion.ts',
            'subscriptions.ts',
            'validation.ts',
            'wait.ts',
            'ws-inbox.ts',
        ]);
        const runtimeDirectory = path.resolve(
            'packages/shared-web/browser/rallar-runtime',
        );
        const runtimeFiles = readdirSync(runtimeDirectory).filter((fileName) =>
            fileName.endsWith('.ts') &&
            fileName !== 'compose.ts' &&
            fileName !== 'composition.ts'
        );
        const references = runtimeFiles.flatMap((fileName) => {
            const sourceFile = readSourceAnalysis(
                `packages/shared-web/browser/rallar-runtime/${fileName}`,
            );
            return sourceFile.imports
                .map((entry) => entry.specifier)
                .filter((specifier) =>
                    specifier.startsWith(
                        '@shared-web/browser/rallar-runtime/',
                    )
                )
                .map((specifier) => specifier.split('/').at(-1) ?? '')
                .filter((dependency) =>
                    !allowedRuntimeDependencies.has(dependency)
                )
                .map((dependency) => `${fileName}: ${dependency}`);
        });

        expect(references).toEqual([]);
    });

    it('does not publicly barrel-export internal runtime modules', () => {
        const publicBarrels = [
            'packages/shared-web/mod.ts',
            ...BROWSER_ENTRYPOINTS.map((entrypoint) => entrypoint.sourcePath),
        ];
        const references = publicBarrels.flatMap((filePath) =>
            collectInternalRuntimeExports(readSourceAnalysis(filePath)).map(
                (reference) => `${filePath}: ${reference}`,
            )
        );

        expect(references).toEqual([]);
    });

    it('keeps rallar.ts as a thin compatibility entrypoint', () => {
        const sourceFile = readSourceAnalysis(
            'packages/shared-web/browser/rallar.ts',
        );
        const classNames = sourceFile.topLevelDeclarations
            .filter((declaration) => declaration.kind === 'class')
            .map((declaration) => declaration.name);
        const runtimeImports = sourceFile.imports
            .filter(isRuntimeImport)
            .map((entry) => entry.specifier);

        expect(classNames).not.toContain('BrowserRallarFacade');
        expect(runtimeImports).toContain(
            '@shared-web/browser/rallar-runtime/compose.ts',
        );
    });
});

function collectFullFacadeReferences(
    sourceFile: SourceAnalysis,
): readonly string[] {
    return [
        ...sourceFile.imports
            .map((entry) => entry.specifier)
            .filter(isFullFacadeSpecifier)
            .map((specifier) => `import ${specifier}`),
        ...sourceFile.exports
            .flatMap((entry) => entry.specifier ? [entry.specifier] : [])
            .filter(isFullFacadeSpecifier)
            .map((specifier) => `export ${specifier}`),
    ];
}

function collectInternalRuntimeExports(
    sourceFile: SourceAnalysis,
): readonly string[] {
    return sourceFile.exports
        .flatMap((entry) => entry.specifier ? [entry.specifier] : [])
        .filter((moduleSpecifier) =>
            moduleSpecifier.includes('/rallar-runtime/')
        );
}

function collectModuleReferences(
    sourceFile: SourceAnalysis,
    expectedSpecifier: string,
): readonly string[] {
    return [
        ...sourceFile.imports
            .filter((entry) => entry.specifier === expectedSpecifier)
            .map(() => `import ${expectedSpecifier}`),
        ...sourceFile.exports
            .filter((entry) => entry.specifier === expectedSpecifier)
            .map(() => `export ${expectedSpecifier}`),
    ];
}

function collectRuntimeFullFacadeReferences(
    sourceFile: SourceAnalysis,
): readonly string[] {
    return [
        ...sourceFile.imports
            .filter(isRuntimeImport)
            .map((entry) => entry.specifier)
            .filter(isFullFacadeSpecifier)
            .map((specifier) => `import ${specifier}`),
        ...sourceFile.exports
            .filter((entry) => !entry.typeOnly)
            .flatMap((entry) => entry.specifier ? [entry.specifier] : [])
            .filter(isFullFacadeSpecifier)
            .map((specifier) => `export ${specifier}`),
    ];
}

function isRuntimeImport(entry: SourceImport): boolean {
    return !entry.typeOnly && (
        entry.sideEffectOnly ||
        entry.defaultImport !== undefined ||
        entry.namespaceImport !== undefined ||
        entry.namedImports.some((namedImport) => !namedImport.typeOnly)
    );
}

function readSourceAnalysis(filePath: string): SourceAnalysis {
    return analyzeSourceFile(path.resolve(process.cwd(), filePath));
}

function isFullFacadeSpecifier(specifier: string): boolean {
    return specifier === '@shared-web/browser/rallar.ts' ||
        specifier === './rallar.ts';
}
