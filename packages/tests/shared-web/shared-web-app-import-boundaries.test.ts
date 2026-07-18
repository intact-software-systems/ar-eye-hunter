import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    analyzeSourceFile,
    type SourceAnalysis,
} from '../helpers/source-analysis';

const repoRoot = process.cwd();

describe('shared-web app import boundaries', () => {
    it('keeps AR Eye on explicit Rallar surfaces without broad side-effect barrels', () => {
        const analysis = readSourceAnalysis('apps/ar-eye-hunter-v1/src/main.tsx');
        const sideEffectImports = collectSideEffectImports(analysis);

        for (const broadBarrel of [
            '@shared/mod.ts',
            '@shared-graph/mod.ts',
            '@shared-web/mod.ts',
        ]) {
            expect(sideEffectImports, broadBarrel).not.toContain(broadBarrel);
        }
        expect(collectNamedImports(analysis)).toContainEqual({
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
            const analysis = readSourceAnalysis(sourcePath);
            expect(
                collectModuleImports(analysis),
                sourcePath,
            ).not.toContain('@shared-web/mod.ts');
        }
    });

    it('keeps Rallar Black Box as the full-facade dynamic compatibility consumer', () => {
        const dynamicTargets = [
            ...collectDynamicImports(
                readSourceAnalysis('apps/rallar-black-box/src/direct-rallar-operations.ts'),
            ),
            ...collectDynamicImports(
                readSourceAnalysis('apps/rallar-black-box/src/App.tsx'),
            ),
        ];

        expect(dynamicTargets).toContain('@shared-web/browser/rallar.ts');
    });
});

function collectSideEffectImports(analysis: SourceAnalysis): readonly string[] {
    return analysis.imports
        .filter((entry) => entry.sideEffectOnly)
        .map((entry) => entry.specifier);
}

function collectNamedImports(
    analysis: SourceAnalysis,
): readonly Readonly<{ moduleSpecifier: string; importedName: string }>[] {
    return analysis.imports.flatMap((entry) =>
        entry.namedImports.map((namedImport) => ({
            moduleSpecifier: entry.specifier,
            importedName: namedImport.local,
        })),
    );
}

function collectModuleImports(analysis: SourceAnalysis): readonly string[] {
    return analysis.imports.map((entry) => entry.specifier);
}

function collectDynamicImports(analysis: SourceAnalysis): readonly string[] {
    return analysis.dynamicImports.flatMap((entry) =>
        entry.literal && entry.specifier ? [entry.specifier] : [],
    );
}

function readSourceAnalysis(filePath: string): SourceAnalysis {
    return analyzeSourceFile(path.join(repoRoot, filePath));
}

function readSource(filePath: string): string {
    return readFileSync(path.join(repoRoot, filePath), 'utf8');
}
