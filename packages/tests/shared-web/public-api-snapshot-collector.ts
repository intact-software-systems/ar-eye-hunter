import path from 'node:path';
import { analyzeSourceFile, type SourceAnalysis } from '../helpers/source-analysis';

export interface ExportSnapshot {
    readonly values: readonly string[];
    readonly types: readonly string[];
    readonly starExports: readonly string[];
    readonly namespaceExports: readonly string[];
}

export interface CollectExportSnapshotOptions {
    readonly resolveStarExports: boolean;
}

export function collectExportSnapshot(
    filePath: string,
    options: CollectExportSnapshotOptions
): ExportSnapshot {
    const analysis = readSourceAnalysis(filePath);
    const direct = collectDirectExports(analysis);
    if (!options.resolveStarExports) {
        return direct;
    }

    const resolved = collectResolvedExports(filePath, new Set([filePath]));
    return {
        values: sortUnique([...direct.values, ...resolved.values]),
        types: sortUnique([...direct.types, ...resolved.types]),
        starExports: direct.starExports,
        namespaceExports: direct.namespaceExports
    };
}

function collectResolvedExports(
    filePath: string,
    seen: Set<string>
): Pick<ExportSnapshot, 'values' | 'types'> {
    const direct = collectDirectExports(readSourceAnalysis(filePath));
    const values = [...direct.values];
    const types = [...direct.types];

    for (const specifier of direct.starExports) {
        const resolved = resolveLocalModule(filePath, specifier);
        if (!resolved || seen.has(resolved)) {
            continue;
        }

        seen.add(resolved);
        const child = collectResolvedExports(resolved, seen);
        values.push(...child.values);
        types.push(...child.types);
    }

    return {
        values: sortUnique(values),
        types: sortUnique(types)
    };
}

function collectDirectExports(analysis: SourceAnalysis): ExportSnapshot {
    const values: string[] = [];
    const types: string[] = [];
    const starExports: string[] = [];
    const namespaceExports: string[] = [];

    for (const entry of analysis.exports) {
        if (entry.kind === 'star' && entry.specifier) {
            starExports.push(entry.specifier);
            continue;
        }

        if (entry.kind === 'namespace' && entry.exportedName && entry.specifier) {
            namespaceExports.push(`${entry.exportedName} from ${entry.specifier}`);
            continue;
        }

        const exportName = entry.kind === 'default' ? entry.localName : entry.exportedName;
        if (!exportName) {
            continue;
        }

        if (entry.typeOnly) {
            types.push(exportName);
        }
        else {
            values.push(exportName);
        }
    }

    return {
        values: sortUnique(values),
        types: sortUnique(types),
        starExports: sortUnique(starExports),
        namespaceExports: sortUnique(namespaceExports)
    };
}

function readSourceAnalysis(filePath: string): SourceAnalysis {
    return analyzeSourceFile(toAbsolutePath(filePath));
}

function resolveLocalModule(
    filePath: string,
    specifier: string
): string | undefined {
    if (!specifier.startsWith('.')) {
        return undefined;
    }
    return path.relative(
        process.cwd(),
        path.resolve(path.dirname(toAbsolutePath(filePath)), specifier)
    );
}

function toAbsolutePath(filePath: string): string {
    return path.resolve(process.cwd(), filePath);
}

function sortUnique(values: readonly string[]): readonly string[] {
    return [...new Set(values)].sort();
}
