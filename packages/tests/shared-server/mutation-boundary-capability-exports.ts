import { parse } from '@babel/parser';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

type AstNode = { readonly type: string; readonly [key: string]: unknown; };
const capabilityExports = new Map<string, ReadonlySet<string>>();

export function readCapabilityExports(specifier: string): ReadonlySet<string> {
    const entry = specifier.startsWith('@shared-server/')
        ? `packages/shared-server/${specifier.slice('@shared-server/'.length)}`
        : specifier.endsWith('/shared-server/mod.ts')
        ? 'packages/shared-server/mod.ts'
        : '';
    return entry ? readCapabilityExportsFromFile(entry, new Set()) : new Set();
}

function readCapabilityExportsFromFile(
    filePath: string,
    visiting: Set<string>
): ReadonlySet<string> {
    const normalized = filePath.split(path.sep).join('/');
    const cached = capabilityExports.get(normalized);
    if (cached) {
        return cached;
    }
    if (visiting.has(normalized) || !existsSync(normalized)) {
        return new Set();
    }
    visiting.add(normalized);
    const program = parse(readFileSync(normalized, 'utf8'), {
        sourceType: 'module',
        plugins: ['typescript']
    }).program;
    const exports = new Set<string>();
    for (const statement of program.body as AstNode[]) {
        const declaration = asNode(statement.declaration);
        const declaredName = readName(declaration?.id);
        if (declaredName && isMutableCapability(declaredName)) {
            exports.add(declaredName);
        }
        const source = readString(statement.source);
        if (!source || !source.startsWith('.')) {
            continue;
        }
        const resolved = path.resolve(path.dirname(normalized), source);
        const target = path.relative(process.cwd(), resolved).split(path.sep).join('/');
        for (const capability of readCapabilityExportsFromFile(target, visiting)) {
            exports.add(capability);
        }
    }
    visiting.delete(normalized);
    capabilityExports.set(normalized, exports);
    return exports;
}

function isMutableCapability(name: string): boolean {
    return /(?:Repository|MutationService|ManagementService)$/u.test(name);
}

function readName(value: unknown): string {
    const node = asNode(value);
    return node && typeof node.name === 'string' ? node.name : '';
}

function readString(value: unknown): string {
    const node = asNode(value);
    return node && typeof node.value === 'string' ? node.value : '';
}

function asNode(value: unknown): AstNode | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
}
