import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSourceFile, type SourceAnalysis, type SourceImport } from '../helpers/source-analysis';

interface BrowserEntrypoint {
    readonly moduleId: string;
    readonly sourcePath: string;
    readonly expectedRuntimeExports: readonly string[];
    readonly forbiddenRuntimeExports: readonly string[];
}

const BROWSER_ENTRYPOINTS: readonly BrowserEntrypoint[] = [
    {
        moduleId: '@shared-web/browser/rallar-core.ts',
        sourcePath: 'packages/shared-web/browser/rallar-core.ts',
        expectedRuntimeExports: [
            'configureApiClient',
            'matchesRallarMessageSelector',
            'normalizeRallarMessageSelector',
            'normalizeApiBaseUrl',
            'readApiBaseUrl'
        ],
        forbiddenRuntimeExports: [
            'createRallarCrdtFacade',
            'createRallarDataFacade',
            'createRallarFacade',
            'createRallarMediaFacade',
            'createRallarCallsFacade',
            'rallar'
        ]
    },
    {
        moduleId: '@shared-web/browser/rallar-realtime.ts',
        sourcePath: 'packages/shared-web/browser/rallar-realtime.ts',
        expectedRuntimeExports: [
            'configureApiClient',
            'matchesRallarMessageSelector',
            'normalizeRallarMessageSelector',
            'normalizeApiBaseUrl',
            'readApiBaseUrl'
        ],
        forbiddenRuntimeExports: [
            'createRallarCrdtFacade',
            'createRallarDataFacade',
            'createRallarFacade',
            'createRallarMediaFacade',
            'createRallarCallsFacade',
            'createRallarRealtimeFacade',
            'createRallarRtcFacade',
            'rallar'
        ]
    },
    {
        moduleId: '@shared-web/browser/rallar-media-calls.ts',
        sourcePath: 'packages/shared-web/browser/rallar-media-calls.ts',
        expectedRuntimeExports: [],
        forbiddenRuntimeExports: [
            'createRallarCrdtFacade',
            'createRallarDataFacade',
            'createRallarFacade',
            'createRallarCallsFacade',
            'createRallarMediaFacade',
            'createRallarRealtimeFacade',
            'createRallarRtcFacade',
            'rallar'
        ]
    }
];

const PUBLIC_FACADE_MODULES = [
    'packages/shared-web/browser/session/rallar-auth-facade.ts',
    'packages/shared-web/browser/rallar-calls-facade.ts',
    'packages/shared-web/browser/rallar-connection-facade.ts',
    'packages/shared-web/browser/director/rallar-director-facade.ts',
    'packages/shared-web/browser/rallar-media-facade.ts',
    'packages/shared-web/browser/rallar-realtime-facade.ts',
    'packages/shared-web/browser/rooms/rallar-room-contracts.ts',
    'packages/shared-web/browser/rallar-rtc-facade.ts'
] as const;

const PRIVATE_BROWSER_OWNER_DIRECTORIES = [
    'api',
    'auth',
    'calls',
    'composition',
    'connection',
    'crdt',
    'data',
    'director',
    'media',
    'messages',
    'people',
    'realtime',
    'rooms',
    'rtc',
    'rtc-diagnostics',
    'session',
    'state-cache',
    'state-read',
    'stats',
    'websocket'
] as const;

const AGGREGATE_FACADE_OWNERS = new Set([
    'packages/shared-web/browser/composition/browser-facade-assembly.ts',
    'packages/shared-web/browser/composition/create-rallar-facade.ts'
]);

const PRIVATE_RUNTIME_MODULE_SEGMENTS = [
    '/composition/',
    '/connection/browser-transport-runtime.ts',
    '/connection/normalize-wait-timeout-ms.ts',
    '/messages/rallar-listener-delivery.ts',
    '/people/browser-rallar-people-events.ts',
    '/rooms/rallar-room-validation.ts',
    '/session/rallar-lifecycle-coordinator.ts',
    '/session/rallar-session-controller.ts',
    '/session/rallar-startup-controller.ts',
    '/state-cache/rallar-state-store.ts'
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
                (reference) => `${filePath}: ${reference}`
            )
        );

        expect(references).toEqual([]);
    });

    it('keeps public facade contracts independent from the aggregate contract', () => {
        const references = PUBLIC_FACADE_MODULES.flatMap((filePath) =>
            collectModuleReferences(
                readSourceAnalysis(filePath),
                '@shared-web/browser/rallar-facade-contract.ts'
            ).map((reference) => `${filePath}: ${reference}`)
        );

        expect(references).toEqual([]);
    });

    it('keeps feature owners independent from the full facade entrypoint', () => {
        const references = collectPrivateBrowserOwnerFiles().flatMap((filePath) =>
            collectFullFacadeReferences(
                readSourceAnalysis(filePath)
            ).map((reference) => `${filePath}: ${reference}`)
        );

        expect(references).toEqual([]);
    });

    it('keeps feature owners independent from the aggregate contract', () => {
        const references = collectPrivateBrowserOwnerFiles()
            .filter((filePath) => !AGGREGATE_FACADE_OWNERS.has(filePath))
            .flatMap((filePath) =>
                collectModuleReferences(
                    readSourceAnalysis(filePath),
                    '@shared-web/browser/rallar-facade-contract.ts'
                ).map((reference) => `${filePath}: ${reference}`)
            );

        expect(references).toEqual([]);
    });

    it('keeps mutable state-cache access inside the state store', () => {
        const stateStorePath = 'packages/shared-web/browser/state-cache/rallar-state-store.ts';
        const references = collectPrivateBrowserOwnerFiles()
            .filter((filePath) => filePath !== stateStorePath)
            .flatMap((filePath) =>
                collectModuleReferences(
                    readSourceAnalysis(filePath),
                    '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'
                ).map((reference) => `${filePath}: ${reference}`)
            );

        expect(references).toEqual([]);
    });

    it('does not publicly barrel-export internal runtime modules', () => {
        const publicBarrels = [
            'packages/shared-web/mod.ts',
            ...BROWSER_ENTRYPOINTS.map((entrypoint) => entrypoint.sourcePath)
        ];
        const references = publicBarrels.flatMap((filePath) =>
            collectInternalRuntimeExports(readSourceAnalysis(filePath)).map(
                (reference) => `${filePath}: ${reference}`
            )
        );

        expect(references).toEqual([]);
    });
});

function collectFullFacadeReferences(
    sourceFile: SourceAnalysis
): readonly string[] {
    return [
        ...sourceFile.imports
            .map((entry) => entry.specifier)
            .filter(isFullFacadeSpecifier)
            .map((specifier) => `import ${specifier}`),
        ...sourceFile.exports
            .flatMap((entry) => (entry.specifier ? [entry.specifier] : []))
            .filter(isFullFacadeSpecifier)
            .map((specifier) => `export ${specifier}`)
    ];
}

function collectInternalRuntimeExports(
    sourceFile: SourceAnalysis
): readonly string[] {
    return sourceFile.exports
        .flatMap((entry) => (entry.specifier ? [entry.specifier] : []))
        .filter((moduleSpecifier) => PRIVATE_RUNTIME_MODULE_SEGMENTS.some((segment) => moduleSpecifier.includes(segment)));
}

function collectPrivateBrowserOwnerFiles(): readonly string[] {
    return PRIVATE_BROWSER_OWNER_DIRECTORIES.flatMap((directoryName) =>
        collectTypeScriptSourceFiles(
            `packages/shared-web/browser/${directoryName}`
        )
    );
}

function collectTypeScriptSourceFiles(directoryPath: string): readonly string[] {
    return readdirSync(path.resolve(directoryPath), { withFileTypes: true })
        .flatMap((entry) => {
            const entryPath = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) {
                return collectTypeScriptSourceFiles(entryPath);
            }
            return entry.isFile() && entry.name.endsWith('.ts')
                ? [entryPath]
                : [];
        });
}

function collectModuleReferences(
    sourceFile: SourceAnalysis,
    expectedSpecifier: string
): readonly string[] {
    return [
        ...sourceFile.imports
            .filter((entry) => entry.specifier === expectedSpecifier)
            .map(() => `import ${expectedSpecifier}`),
        ...sourceFile.exports
            .filter((entry) => entry.specifier === expectedSpecifier)
            .map(() => `export ${expectedSpecifier}`)
    ];
}

function collectRuntimeFullFacadeReferences(
    sourceFile: SourceAnalysis
): readonly string[] {
    return [
        ...sourceFile.imports
            .filter(isRuntimeImport)
            .map((entry) => entry.specifier)
            .filter(isFullFacadeSpecifier)
            .map((specifier) => `import ${specifier}`),
        ...sourceFile.exports
            .filter((entry) => !entry.typeOnly)
            .flatMap((entry) => (entry.specifier ? [entry.specifier] : []))
            .filter(isFullFacadeSpecifier)
            .map((specifier) => `export ${specifier}`)
    ];
}

function isRuntimeImport(entry: SourceImport): boolean {
    return (
        !entry.typeOnly &&
        (entry.sideEffectOnly ||
            entry.defaultImport !== undefined ||
            entry.namespaceImport !== undefined ||
            entry.namedImports.some((namedImport) => !namedImport.typeOnly))
    );
}

function readSourceAnalysis(filePath: string): SourceAnalysis {
    return analyzeSourceFile(path.resolve(process.cwd(), filePath));
}

function isFullFacadeSpecifier(specifier: string): boolean {
    return (
        specifier === '@shared-web/browser/rallar.ts' || specifier === './rallar.ts'
    );
}
