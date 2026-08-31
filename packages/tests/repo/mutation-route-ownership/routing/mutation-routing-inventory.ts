import { parse } from '@babel/parser';
import { readFileSync } from 'node:fs';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';

import { findAstNode, type MutationRoutingAstNode } from './mutation-routing-call-graph.ts';
import { hasExactGroupRegistrationRoot } from './mutation-routing-group-registration.ts';
import { findExactHttpRouteHandler } from './mutation-routing-http-registration.ts';
import { decodeMutationRouteInventory } from './mutation-routing-inventory-decoding.ts';
import { MUTATION_ROUTE_INVENTORY_ROWS } from './mutation-routing-owner-inventory.ts';
import { findMutationRouteReachabilityIssues } from './mutation-routing-reachability.ts';

export interface MutationRouteInventoryEntry {
    readonly transport: 'HTTP' | 'WS_INBOX' | 'WS_LIFECYCLE' | 'MAINTENANCE';
    readonly entrypoint: string;
    readonly type: AppInboxType;
    readonly owner: string;
    readonly sourcePath: string;
    readonly registrationMarker: string;
    readonly enqueueSourcePath: string;
    readonly enqueueMarker: string;
    readonly ownerSourcePath: string;
    readonly ownerDispatchPath: string;
    readonly typeOwnerSourcePath: string;
    readonly dispatchSourcePath: string;
    readonly operationDiscriminant?: string;
    readonly familyRegistrationMarker?: string;
    readonly constructionRootSourcePath?: string;
    readonly constructionRootMarker?: string;
}

export const MUTATION_ROUTE_INVENTORY: readonly MutationRouteInventoryEntry[] = decodeMutationRouteInventory(MUTATION_ROUTE_INVENTORY_ROWS);

export interface MutationRouteValidationOptions {
    readonly sourceOverrides?: ReadonlyMap<string, string>;
}

interface AstMarkerCheckInput {
    readonly issues: string[];
    readonly filePath: string;
    readonly marker: string;
    readonly label: string;
    readonly item: MutationRouteInventoryEntry;
    readonly sources: SourceReader;
}

const CANONICAL_INVENTORY_FIELDS = [
    'owner',
    'sourcePath',
    'registrationMarker',
    'enqueueSourcePath',
    'enqueueMarker',
    'ownerSourcePath',
    'ownerDispatchPath',
    'typeOwnerSourcePath',
    'dispatchSourcePath',
    'operationDiscriminant',
    'familyRegistrationMarker',
    'constructionRootSourcePath',
    'constructionRootMarker'
] as const;

export function validateMutationRouteInventory(
    inventory: readonly MutationRouteInventoryEntry[],
    options: MutationRouteValidationOptions = {}
): readonly string[] {
    const issues: string[] = [];
    const sources = createSourceReader(options);
    const seen = new Set<string>();
    for (const item of inventory) {
        const itemKey = key(item);
        if (seen.has(itemKey)) {
            issues.push(`Duplicate mutation route: ${itemKey}`);
        }
        seen.add(itemKey);
    }
    const canonicalByKey = new Map(MUTATION_ROUTE_INVENTORY.map((item) => [key(item), item]));
    for (const expectedKey of canonicalByKey.keys()) {
        if (!seen.has(expectedKey)) {
            issues.push(`Missing mutation route: ${expectedKey}`);
        }
    }
    for (const item of inventory) {
        const canonical = canonicalByKey.get(key(item));
        if (!canonical) {
            issues.push(`Unknown mutation route: ${key(item)}`);
            continue;
        }
        for (const field of CANONICAL_INVENTORY_FIELDS) {
            if (item[field] !== canonical[field]) {
                issues.push(`${key(item)} has incorrect ${field}`);
            }
        }
        checkRegistration(issues, item, sources);
        checkAstMarker({
            issues,
            filePath: item.enqueueSourcePath,
            marker: item.enqueueMarker,
            label: 'enqueue',
            item,
            sources
        });
        checkAstMarker({
            issues,
            filePath: item.typeOwnerSourcePath,
            marker: `AppInboxType.${item.type}`,
            label: 'type ownership',
            item,
            sources
        });
        checkOwnerMethod(issues, item, sources);
        checkRegisteredHandlerCallChain(issues, item, sources);
    }
    return issues;
}

function key(item: MutationRouteInventoryEntry): string {
    return `${item.transport}:${item.entrypoint}:${item.type}`;
}
function checkRegistration(
    issues: string[],
    item: MutationRouteInventoryEntry,
    sources: SourceReader
): void {
    if (item.transport !== 'HTTP') {
        checkAstMarker({
            issues,
            filePath: item.sourcePath,
            marker: item.registrationMarker,
            label: 'registration',
            item,
            sources
        });
        return;
    }
    const [method, routePath] = item.entrypoint.split(' ');
    const program = sources.readProgram({ issues, filePath: item.sourcePath, label: 'registration', item });
    if (!program) {
        return;
    }
    const rootProgram = item.constructionRootSourcePath
        ? sources.readProgram({ issues, filePath: item.constructionRootSourcePath, label: 'registration root', item })
        : undefined;
    const handler = findExactHttpRouteHandler({
        program,
        method: method.toLowerCase(),
        routePath,
        registrationMarker: item.registrationMarker,
        familyRegistrationMarker: item.familyRegistrationMarker,
        expectedFamilyRouteCount: readCanonicalFamilyRouteCount(item)
    });
    const hasRoot = !item.familyRegistrationMarker ||
        Boolean(
            rootProgram &&
                item.constructionRootMarker &&
                item.constructionRootSourcePath &&
                hasExactGroupRegistrationRoot({
                    program: rootProgram,
                    rootOwnerName: item.constructionRootMarker,
                    rootSourcePath: item.constructionRootSourcePath,
                    familyOwnerName: item.familyRegistrationMarker,
                    familySourcePath: item.sourcePath
                })
        );
    if (!handler || !hasRoot) {
        issues.push(`${key(item)} registration is absent from ${item.sourcePath}`);
    }
}

function readCanonicalFamilyRouteCount(
    item: MutationRouteInventoryEntry
): number | undefined {
    if (!item.familyRegistrationMarker) {
        return undefined;
    }
    return MUTATION_ROUTE_INVENTORY.filter(
        (candidate) => candidate.familyRegistrationMarker === item.familyRegistrationMarker
    ).length;
}

function checkAstMarker({
    issues,
    filePath,
    marker,
    label,
    item,
    sources
}: AstMarkerCheckInput): void {
    const program = sources.readProgram({ issues, filePath, label, item });
    if (program && !hasExactMarker(program, marker)) {
        issues.push(`${key(item)} ${label} marker is absent from ${filePath}`);
    }
}
function checkOwnerMethod(
    issues: string[],
    item: MutationRouteInventoryEntry,
    sources: SourceReader
): void {
    const method = item.owner.split('.').at(-1) ?? '';
    const program = sources.readProgram({ issues, filePath: item.ownerSourcePath, label: 'owner', item });
    if (program && !hasOwnerCallable(program, method)) {
        issues.push(`${key(item)} owner method is absent from ${item.ownerSourcePath}`);
    }
}

interface ReadMutationInventoryProgramInput {
    readonly issues: string[];
    readonly filePath: string;
    readonly label: string;
    readonly item: MutationRouteInventoryEntry;
}

interface SourceReader {
    readProgram(input: ReadMutationInventoryProgramInput): MutationRoutingAstNode | undefined;
}

function createSourceReader(options: MutationRouteValidationOptions): SourceReader {
    const cache = new Map<string, MutationRoutingAstNode>();
    return {
        readProgram: ({ issues, filePath, label, item }) => {
            const cached = cache.get(filePath);
            if (cached) {
                return cached;
            }
            try {
                const source = options.sourceOverrides?.get(filePath) ?? readFileSync(filePath, 'utf8');
                const program: MutationRoutingAstNode = {
                    ...parse(source, {
                        sourceType: 'module',
                        sourceFilename: filePath,
                        plugins: ['typescript']
                    }).program
                };
                cache.set(filePath, program);
                return program;
            }
            catch {
                issues.push(`${key(item)} ${label} source cannot be parsed: ${filePath}`);
                return undefined;
            }
        }
    };
}
function checkRegisteredHandlerCallChain(
    issues: string[],
    item: MutationRouteInventoryEntry,
    sources: SourceReader
): void {
    const source = sources.readProgram({ issues, filePath: item.sourcePath, label: 'call chain', item });
    const enqueue = sources.readProgram({ issues, filePath: item.enqueueSourcePath, label: 'call chain', item });
    const owner = sources.readProgram({ issues, filePath: item.ownerSourcePath, label: 'owner', item });
    const typeOwner = sources.readProgram({ issues, filePath: item.typeOwnerSourcePath, label: 'type owner', item });
    const dispatch = sources.readProgram({ issues, filePath: item.dispatchSourcePath, label: 'owner dispatch', item });
    if (!source || !enqueue || !owner || !typeOwner || !dispatch) {
        return;
    }
    issues.push(
        ...findMutationRouteReachabilityIssues({
            item,
            source,
            enqueueSource: enqueue,
            ownerSource: owner,
            typeOwnerSource: typeOwner,
            dispatchSource: dispatch,
            containsMarker: hasExactMarker,
            matchesMarker: hasDirectExactMarker,
            loadProgram: (filePath) => sources.readProgram({ issues, filePath, label: 'owner dependency', item })
        })
    );
}

function hasExactMarker(program: MutationRoutingAstNode, marker: string): boolean {
    return someNode(program, (node) => hasDirectExactMarker(node, marker));
}

function hasDirectExactMarker(program: MutationRoutingAstNode, marker: string): boolean {
    const member = marker.match(/^(\w+)\.(\w+)$/);
    if (member) {
        const memberPath = readMemberPath(program);
        return memberPath === marker || memberPath.endsWith(`.${marker}`);
    }
    const quoted = marker.match(/^'([^']+)'$/);
    if (quoted) {
        return readString(program) === quoted[1];
    }
    const comparison = marker.match(/^([\w.]+) === '([^']+)'$/);
    if (comparison) {
        return (
            program.type === 'BinaryExpression' &&
            program.operator === '===' &&
            readMemberPath(asNode(program.left)) === comparison[1] &&
            readString(asNode(program.right)) === comparison[2]
        );
    }
    const call = marker.match(/^(?:(\w+)\.)?(\w+)\((?:[^']*'([^']+)')?/);
    if (call) {
        if (program.type !== 'CallExpression') {
            return false;
        }
        const callee = asNode(program.callee);
        if (readCallName(callee) !== call[2]) {
            return false;
        }
        if (call[1] && readIdentifier(asNode(callee?.object)) !== call[1]) {
            return false;
        }
        return (
            !call[3] ||
            asNodes(program.arguments).some((argument) => someNode(argument, (node) => readString(node) === call[3]))
        );
    }
    const property = marker.replace(/:$/, '');
    return (
        readIdentifier(program) === property ||
        readMemberName(program) === property ||
        ((program.type === 'ObjectProperty' || program.type === 'ObjectMethod') &&
            readIdentifier(asNode(program.key)) === property)
    );
}

function hasOwnerCallable(program: MutationRoutingAstNode, method: string): boolean {
    return someNode(
        program,
        (node) =>
            ((node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod') &&
                readIdentifier(asNode(node.key)) === method) ||
            (node.type === 'FunctionDeclaration' && readIdentifier(asNode(node.id)) === method) ||
            (node.type === 'ImportSpecifier' &&
                (readIdentifier(asNode(node.local)) === method ||
                    readIdentifier(asNode(node.imported)) === method))
    );
}

function someNode(value: unknown, predicate: (node: MutationRoutingAstNode) => boolean): boolean {
    return findAstNode(value, predicate) !== undefined;
}

function readCallName(node: MutationRoutingAstNode | undefined): string {
    return readIdentifier(node) || readMemberName(node);
}

function readMemberName(node: MutationRoutingAstNode | undefined): string {
    return node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression'
        ? readIdentifier(asNode(node.property))
        : '';
}

function readMemberPath(node: MutationRoutingAstNode | undefined): string {
    if (!node) {
        return '';
    }
    if (node.type === 'Identifier') {
        return readIdentifier(node);
    }
    if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') {
        return '';
    }
    const object = readMemberPath(asNode(node.object));
    const property = readIdentifier(asNode(node.property));
    return object && property ? `${object}.${property}` : '';
}

function readIdentifier(node: MutationRoutingAstNode | undefined): string {
    return node && typeof node.name === 'string' ? node.name : '';
}

function readString(node: MutationRoutingAstNode | undefined): string {
    return node && typeof node.value === 'string' ? node.value : '';
}

function asNode(value: unknown): MutationRoutingAstNode | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as MutationRoutingAstNode)
        : undefined;
}

function asNodes(value: unknown): readonly MutationRoutingAstNode[] {
    return Array.isArray(value)
        ? value.map(asNode).filter((node): node is MutationRoutingAstNode => node !== undefined)
        : [];
}
