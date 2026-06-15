import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

describe('shared-web app import boundaries', () => {
    it('keeps AR Eye on explicit Rallar surfaces without broad side-effect barrels', () => {
        const sourceFile = readSourceFile('apps/ar-eye-hunter-v1/src/main.tsx');
        const sideEffectImports = collectSideEffectImports(sourceFile);

        for (const broadBarrel of [
            '@shared/mod.ts',
            '@shared-graph/mod.ts',
            '@shared-web/mod.ts',
        ]) {
            expect(sideEffectImports, broadBarrel).not.toContain(broadBarrel);
        }
        expect(collectNamedImports(sourceFile)).toContainEqual({
            moduleSpecifier: '@shared-web/browser/rallar.ts',
            importedName: 'rallar',
        });
    });

    it('keeps Relic on its runtime adapter boundary without the broad shared-web barrel', () => {
        const runtimeSource = readSource(
            'apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts',
        );
        const relicSources = [
            'apps/relic-hunters-v1/src/main.tsx',
            'apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts',
            'apps/relic-hunters-v1/src/game/scene/networking.ts',
            'apps/relic-hunters-v1/src/game/ai/useRelicPlanningAi.ts',
        ];

        expect(runtimeSource).toContain('export type RelicHuntersRuntimeDeps');
        expect(runtimeSource).toContain(
            'constructor(private readonly deps: RelicHuntersRuntimeDeps = browserRelicRuntimeDeps())',
        );

        for (const sourcePath of relicSources) {
            const sourceFile = readSourceFile(sourcePath);
            expect(
                collectModuleImports(sourceFile),
                sourcePath,
            ).not.toContain('@shared-web/mod.ts');
        }
    });

    it('keeps Rallar Black Box as the full-facade dynamic compatibility consumer', () => {
        const dynamicTargets = [
            ...collectDynamicImports(
                readSourceFile('apps/rallar-black-box/src/direct-rallar-operations.ts'),
            ),
            ...collectDynamicImports(
                readSourceFile('apps/rallar-black-box/src/App.tsx'),
            ),
        ];

        expect(dynamicTargets).toContain('@shared-web/browser/rallar.ts');
    });
});

function collectSideEffectImports(sourceFile: ts.SourceFile): readonly string[] {
    return sourceFile.statements
        .filter(ts.isImportDeclaration)
        .filter((statement) => !statement.importClause)
        .map(readImportModuleSpecifier)
        .filter(Boolean);
}

function collectNamedImports(
    sourceFile: ts.SourceFile,
): readonly Readonly<{ moduleSpecifier: string; importedName: string }>[] {
    const namedImports: { moduleSpecifier: string; importedName: string }[] = [];

    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)) {
            continue;
        }

        const moduleSpecifier = readImportModuleSpecifier(statement);
        const namedBindings = statement.importClause?.namedBindings;
        if (!namedBindings || !ts.isNamedImports(namedBindings)) {
            continue;
        }

        for (const element of namedBindings.elements) {
            namedImports.push({
                moduleSpecifier,
                importedName: element.name.text,
            });
        }
    }

    return namedImports;
}

function collectModuleImports(sourceFile: ts.SourceFile): readonly string[] {
    return sourceFile.statements
        .filter(ts.isImportDeclaration)
        .map(readImportModuleSpecifier)
        .filter(Boolean);
}

function collectDynamicImports(sourceFile: ts.SourceFile): readonly string[] {
    const dynamicImports: string[] = [];

    function visit(node: ts.Node): void {
        if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments.length === 1
        ) {
            const argument = node.arguments[0];
            if (ts.isStringLiteral(argument)) {
                dynamicImports.push(argument.text);
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return dynamicImports;
}

function readImportModuleSpecifier(statement: ts.ImportDeclaration): string {
    const specifier = statement.moduleSpecifier;
    return ts.isStringLiteral(specifier) ? specifier.text : '';
}

function readSourceFile(filePath: string): ts.SourceFile {
    return ts.createSourceFile(
        filePath,
        readSource(filePath),
        ts.ScriptTarget.Latest,
        true,
        filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
}

function readSource(filePath: string): string {
    return readFileSync(path.join(repoRoot, filePath), 'utf8');
}
