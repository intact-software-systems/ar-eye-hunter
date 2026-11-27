import { parse } from '@babel/parser';
import { readFileSync } from 'node:fs';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { Either } from '@shared/resilience/Either.ts';

import { MutationRouteResultMemo, type MutationRouteResult } from './mutation-route-result-memo.ts';
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

interface AstMarkerIssuesInput {
    readonly filePath: string;
    readonly marker: string;
    readonly label: string;
    readonly item: MutationRouteInventoryEntry;
    readonly sources: SourceReader;
}

/** A source that could not be read or parsed; each caller words it as its own issue. */
interface SourceReadFailure {
    readonly filePath: string;
}

type SourceRead = Either<SourceReadFailure, MutationRoutingAstNode>;

interface SourceReader {
    readonly readPaths: ReadonlySet<string>;
    readProgram(filePath: string): SourceRead;
}

interface CallChainPrograms {
    readonly source: MutationRoutingAstNode;
    readonly enqueueSource: MutationRoutingAstNode;
    readonly ownerSource: MutationRoutingAstNode;
    readonly typeOwnerSource: MutationRoutingAstNode;
    readonly dispatchSource: MutationRoutingAstNode;
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

const CANONICAL_INVENTORY_BY_KEY = new Map(MUTATION_ROUTE_INVENTORY.map((item) => [toRouteKey(item), item]));

// One memo per test file: Vitest isolates modules per file, so remembered results never cross files.
const MUTATION_ROUTE_RESULT_MEMO = new MutationRouteResultMemo();

export function validateMutationRouteInventory(
    inventory: readonly MutationRouteInventoryEntry[],
    options: MutationRouteValidationOptions = {}
): readonly string[] {
    return validateMutationRouteInventoryWithMemo(
        MUTATION_ROUTE_RESULT_MEMO,
        inventory,
        options.sourceOverrides ?? new Map<string, string>()
    );
}

export function validateMutationRouteInventoryWithMemo(
    memo: MutationRouteResultMemo,
    inventory: readonly MutationRouteInventoryEntry[],
    sourceOverrides: ReadonlyMap<string, string>
): readonly string[] {
    const programs = new Map<string, MutationRoutingAstNode>();
    const issues = [...validateInventoryKeys(inventory)];
    for (const item of inventory) {
        const canonical = CANONICAL_INVENTORY_BY_KEY.get(toRouteKey(item));
        if (!canonical) {
            issues.push(`Unknown mutation route: ${toRouteKey(item)}`);
            continue;
        }
        const remembered = memo.getIssues(item, sourceOverrides);
        if (remembered) {
            issues.push(...remembered);
            continue;
        }
        const result = readMutationRouteResult(item, canonical, createSourceReader(sourceOverrides, programs));
        memo.setResult(item, result, sourceOverrides);
        issues.push(...result.issues);
    }
    return issues;
}

function readMutationRouteResult(
    item: MutationRouteInventoryEntry,
    canonical: MutationRouteInventoryEntry,
    sources: SourceReader
): MutationRouteResult {
    const issues = [
        ...validateCanonicalFields(item, canonical),
        ...readRegistrationIssues(item, sources),
        ...readAstMarkerIssues({
            filePath: item.enqueueSourcePath,
            marker: item.enqueueMarker,
            label: 'enqueue',
            item,
            sources
        }),
        ...readAstMarkerIssues({
            filePath: item.typeOwnerSourcePath,
            marker: item.type.startsWith('app:') ? `'${item.type}'` : `AppInboxType.${item.type}`,
            label: 'type ownership',
            item,
            sources
        }),
        ...readOwnerMethodIssues(item, sources),
        ...readCallChainIssues(item, sources)
    ];
    return { issues, readPaths: sources.readPaths };
}

function readRegistrationIssues(item: MutationRouteInventoryEntry, sources: SourceReader): readonly string[] {
    if (item.transport !== 'HTTP') {
        return readAstMarkerIssues({
            filePath: item.sourcePath,
            marker: item.registrationMarker,
            label: 'registration',
            item,
            sources
        });
    }
    return sources.readProgram(item.sourcePath).fold(
        (failure) => [toSourceFailureIssue(item, 'registration', failure)],
        (program) => readHttpRegistrationIssues(item, program, sources)
    );
}

function readHttpRegistrationIssues(
    item: MutationRouteInventoryEntry,
    program: MutationRoutingAstNode,
    sources: SourceReader
): readonly string[] {
    const rootRead = item.constructionRootSourcePath ? sources.readProgram(item.constructionRootSourcePath) : undefined;
    const rootIssues = rootRead ? toSourceReadIssues(item, 'registration root', rootRead) : [];
    const [method, routePath] = item.entrypoint.split(' ');
    const handler = findExactHttpRouteHandler({
        program,
        method: method.toLowerCase(),
        routePath,
        registrationMarker: item.registrationMarker,
        familyRegistrationMarker: item.familyRegistrationMarker,
        expectedFamilyRouteCount: computeCanonicalFamilyRouteCount(item)
    });
    if (handler && hasRegistrationRoot(item, rootRead?.right)) {
        return rootIssues;
    }
    return [...rootIssues, `${toRouteKey(item)} registration is absent from ${item.sourcePath}`];
}

function readAstMarkerIssues({
    filePath,
    marker,
    label,
    item,
    sources
}: AstMarkerIssuesInput): readonly string[] {
    return sources.readProgram(filePath).fold(
        (failure) => [toSourceFailureIssue(item, label, failure)],
        (program) => hasExactMarker(program, marker) ? [] : [`${toRouteKey(item)} ${label} marker is absent from ${filePath}`]
    );
}

function readOwnerMethodIssues(item: MutationRouteInventoryEntry, sources: SourceReader): readonly string[] {
    const method = item.owner.split('.').at(-1) ?? '';
    return sources.readProgram(item.ownerSourcePath).fold(
        (failure) => [toSourceFailureIssue(item, 'owner', failure)],
        (program) =>
            hasOwnerCallable(program, method)
                ? []
                : [`${toRouteKey(item)} owner method is absent from ${item.ownerSourcePath}`]
    );
}

function readCallChainIssues(item: MutationRouteInventoryEntry, sources: SourceReader): readonly string[] {
    const source = sources.readProgram(item.sourcePath);
    const enqueueSource = sources.readProgram(item.enqueueSourcePath);
    const ownerSource = sources.readProgram(item.ownerSourcePath);
    const typeOwnerSource = sources.readProgram(item.typeOwnerSourcePath);
    const dispatchSource = sources.readProgram(item.dispatchSourcePath);
    const readIssues = [
        ...toSourceReadIssues(item, 'call chain', source),
        ...toSourceReadIssues(item, 'call chain', enqueueSource),
        ...toSourceReadIssues(item, 'owner', ownerSource),
        ...toSourceReadIssues(item, 'type owner', typeOwnerSource),
        ...toSourceReadIssues(item, 'owner dispatch', dispatchSource)
    ];
    if (
        !source.right || !enqueueSource.right || !ownerSource.right || !typeOwnerSource.right ||
        !dispatchSource.right
    ) {
        return readIssues;
    }
    return readReachabilityIssues(item, {
        source: source.right,
        enqueueSource: enqueueSource.right,
        ownerSource: ownerSource.right,
        typeOwnerSource: typeOwnerSource.right,
        dispatchSource: dispatchSource.right
    }, sources);
}

function readReachabilityIssues(
    item: MutationRouteInventoryEntry,
    programs: CallChainPrograms,
    sources: SourceReader
): readonly string[] {
    // The analyzer loads owner dependencies while it runs; their failures precede its own issues.
    const loaderIssues: string[] = [];
    const reachabilityIssues = findMutationRouteReachabilityIssues({
        item,
        ...programs,
        containsMarker: hasExactMarker,
        matchesMarker: hasDirectExactMarker,
        loadProgram: (filePath) =>
            sources.readProgram(filePath).fold(
                (failure) => {
                    loaderIssues.push(toSourceFailureIssue(item, 'owner dependency', failure));
                    return undefined;
                },
                (program) => program
            )
    });
    return [...loaderIssues, ...reachabilityIssues];
}

function validateInventoryKeys(inventory: readonly MutationRouteInventoryEntry[]): readonly string[] {
    const issues: string[] = [];
    const seen = new Set<string>();
    for (const item of inventory) {
        const itemKey = toRouteKey(item);
        if (seen.has(itemKey)) {
            issues.push(`Duplicate mutation route: ${itemKey}`);
        }
        seen.add(itemKey);
    }
    for (const expectedKey of CANONICAL_INVENTORY_BY_KEY.keys()) {
        if (!seen.has(expectedKey)) {
            issues.push(`Missing mutation route: ${expectedKey}`);
        }
    }
    return issues;
}

function validateCanonicalFields(
    item: MutationRouteInventoryEntry,
    canonical: MutationRouteInventoryEntry
): readonly string[] {
    return CANONICAL_INVENTORY_FIELDS
        .filter((field) => item[field] !== canonical[field])
        .map((field) => `${toRouteKey(item)} has incorrect ${field}`);
}

function hasRegistrationRoot(
    item: MutationRouteInventoryEntry,
    rootProgram: MutationRoutingAstNode | undefined
): boolean {
    if (!item.familyRegistrationMarker) {
        return true;
    }
    return Boolean(
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
}

function computeCanonicalFamilyRouteCount(
    item: MutationRouteInventoryEntry
): number | undefined {
    if (!item.familyRegistrationMarker) {
        return undefined;
    }
    return MUTATION_ROUTE_INVENTORY.filter(
        (candidate) => candidate.familyRegistrationMarker === item.familyRegistrationMarker
    ).length;
}

function toRouteKey(item: MutationRouteInventoryEntry): string {
    return `${item.transport}:${item.entrypoint}:${item.type}`;
}

function toSourceReadIssues(item: MutationRouteInventoryEntry, label: string, read: SourceRead): readonly string[] {
    return read.fold((failure) => [toSourceFailureIssue(item, label, failure)], () => []);
}

function toSourceFailureIssue(item: MutationRouteInventoryEntry, label: string, failure: SourceReadFailure): string {
    return `${toRouteKey(item)} ${label} source cannot be parsed: ${failure.filePath}`;
}

// Programs are shared by every route of one call; readPaths belongs to the one route this reader serves.
function createSourceReader(
    sourceOverrides: ReadonlyMap<string, string>,
    programs: Map<string, MutationRoutingAstNode>
): SourceReader {
    const readPaths = new Set<string>();
    return {
        readPaths,
        readProgram: (filePath) => {
            readPaths.add(filePath);
            const cached = programs.get(filePath);
            if (cached) {
                return Either.ofRight<SourceReadFailure, MutationRoutingAstNode>(cached);
            }
            try {
                const source = sourceOverrides.get(filePath) ?? readFileSync(filePath, 'utf8');
                const program: MutationRoutingAstNode = {
                    ...parse(source, {
                        sourceType: 'module',
                        sourceFilename: filePath,
                        plugins: ['typescript']
                    }).program
                };
                programs.set(filePath, program);
                return Either.ofRight<SourceReadFailure, MutationRoutingAstNode>(program);
            }
            catch {
                return Either.ofLeft<SourceReadFailure, MutationRoutingAstNode>({ filePath });
            }
        }
    };
}

function hasExactMarker(program: MutationRoutingAstNode, marker: string): boolean {
    return someNode(program, (node) => hasDirectExactMarker(node, marker));
}

function hasDirectExactMarker(program: MutationRoutingAstNode, marker: string): boolean {
    const member = marker.match(/^(\w+)\.(\w+)$/);
    if (member) {
        const memberPath = toMemberPath(program);
        return memberPath === marker || memberPath.endsWith(`.${marker}`);
    }
    const quoted = marker.match(/^'([^']+)'$/);
    if (quoted) {
        return toStringValue(program) === quoted[1];
    }
    const comparison = marker.match(/^([\w.]+) === '([^']+)'$/);
    if (comparison) {
        return (
            program.type === 'BinaryExpression' &&
            program.operator === '===' &&
            toMemberPath(asNode(program.left)) === comparison[1] &&
            toStringValue(asNode(program.right)) === comparison[2]
        );
    }
    const call = marker.match(/^(?:(\w+)\.)?(\w+)\((?:[^']*'([^']+)')?/);
    if (call) {
        return hasExactCallMarker(program, call);
    }
    const property = marker.replace(/:$/, '');
    return (
        toIdentifier(program) === property ||
        toMemberName(program) === property ||
        ((program.type === 'ObjectProperty' || program.type === 'ObjectMethod') &&
            toIdentifier(asNode(program.key)) === property)
    );
}

function hasExactCallMarker(program: MutationRoutingAstNode, call: RegExpMatchArray): boolean {
    if (program.type !== 'CallExpression') {
        return false;
    }
    const callee = asNode(program.callee);
    if (toCallName(callee) !== call[2]) {
        return false;
    }
    if (call[1] && toIdentifier(asNode(callee?.object)) !== call[1]) {
        return false;
    }
    return (
        !call[3] ||
        asNodes(program.arguments).some((argument) => someNode(argument, (node) => toStringValue(node) === call[3]))
    );
}

function hasOwnerCallable(program: MutationRoutingAstNode, method: string): boolean {
    return someNode(
        program,
        (node) =>
            ((node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod') &&
                toIdentifier(asNode(node.key)) === method) ||
            (node.type === 'FunctionDeclaration' && toIdentifier(asNode(node.id)) === method) ||
            (node.type === 'ImportSpecifier' &&
                (toIdentifier(asNode(node.local)) === method ||
                    toIdentifier(asNode(node.imported)) === method))
    );
}

function someNode(value: unknown, predicate: (node: MutationRoutingAstNode) => boolean): boolean {
    return findAstNode(value, predicate) !== undefined;
}

function toCallName(node: MutationRoutingAstNode | undefined): string {
    return toIdentifier(node) || toMemberName(node);
}

function toMemberName(node: MutationRoutingAstNode | undefined): string {
    return node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression'
        ? toIdentifier(asNode(node.property))
        : '';
}

function toMemberPath(node: MutationRoutingAstNode | undefined): string {
    if (!node) {
        return '';
    }
    if (node.type === 'ThisExpression') {
        return 'this';
    }
    if (node.type === 'Identifier') {
        return toIdentifier(node);
    }
    if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') {
        return '';
    }
    const object = toMemberPath(asNode(node.object));
    const property = toIdentifier(asNode(node.property));
    return object && property ? `${object}.${property}` : '';
}

function toIdentifier(node: MutationRoutingAstNode | undefined): string {
    return node && typeof node.name === 'string' ? node.name : '';
}

function toStringValue(node: MutationRoutingAstNode | undefined): string {
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
