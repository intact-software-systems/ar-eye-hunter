import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

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
            const sourceFile = readSourceFile(entrypoint.sourcePath);

            expect(collectRuntimeFullFacadeReferences(sourceFile)).toEqual([]);
        });
    }
});

function collectRuntimeFullFacadeReferences(
    sourceFile: ts.SourceFile,
): readonly string[] {
    const references: string[] = [];

    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
            const moduleSpecifier = readModuleSpecifier(statement);
            if (
                isFullFacadeSpecifier(moduleSpecifier) &&
                statement.importClause?.isTypeOnly !== true
            ) {
                references.push(`import ${moduleSpecifier}`);
            }
            continue;
        }

        if (!ts.isExportDeclaration(statement)) {
            continue;
        }

        const moduleSpecifier = readModuleSpecifier(statement);
        if (
            isFullFacadeSpecifier(moduleSpecifier) &&
            !isTypeOnlyExport(statement)
        ) {
            references.push(`export ${moduleSpecifier}`);
        }
    }

    return references;
}

function isTypeOnlyExport(statement: ts.ExportDeclaration): boolean {
    if (statement.isTypeOnly) {
        return true;
    }

    const exportClause = statement.exportClause;
    return ts.isNamedExports(exportClause) &&
        exportClause.elements.every((element) => element.isTypeOnly);
}

function readSourceFile(filePath: string): ts.SourceFile {
    return ts.createSourceFile(
        filePath,
        readFileSync(path.resolve(process.cwd(), filePath), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
}

function readModuleSpecifier(
    statement: ts.ImportDeclaration | ts.ExportDeclaration,
): string {
    const specifier = statement.moduleSpecifier;
    return specifier && ts.isStringLiteral(specifier) ? specifier.text : '';
}

function isFullFacadeSpecifier(specifier: string): boolean {
    return specifier === '@shared-web/browser/rallar.ts' ||
        specifier === './rallar.ts';
}
