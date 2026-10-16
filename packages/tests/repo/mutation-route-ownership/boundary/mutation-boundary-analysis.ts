import { parse } from '@babel/parser';

import type { MutationRoutingAstNode } from '../routing/mutation-routing-call-graph.ts';
import { findCapabilityMutationCalls } from './capabilities/mutation-boundary-capabilities.ts';
import { findMutationBoundaryViolationsFromRootFiles } from './mutation-boundary-traversal.ts';

const FORBIDDEN_DIRECT_MUTATORS = new Set([
    'registerAuthUser',
    'putSession',
    'deleteSession',
    'putWebSocketTicket',
    'putAgentSessionTicket',
    'consumeAgentSessionTicket',
    'upsertPrincipal',
    'upsertInstance',
    'connectSession',
    'heartbeatSession',
    'disconnectSession',
    'createGroup',
    'updateGroup',
    'joinGroup',
    'putConfig',
    'deleteConfig',
    'putOverride',
    'deleteOverride',
    'reconfigureGroupTopology',
    'removeGroupTopology',
    'writeTopologyMutation',
    'writeRtcRttMutation',
    'writeSnapshot',
    'updateDocumentLifecycle',
    'append'
]);

const FORBIDDEN_MUTATING_IMPORTS = new Set([
    'GroupTopologyConfigMutationService',
    'GroupTopologyReconfigureMutation',
    'GroupTopologyConfigRepository',
    'GroupStateRepository',
    'RtcRttRepository',
    'RtcTopologySnapshotRepository'
]);

const FORBIDDEN_IMPORT_STEMS = [
    'GroupTopologyConfigMutationService',
    'GroupTopologyReconfigureMutation',
    'GroupTopologyConfigRepository',
    'GroupStateRepository',
    'RtcRttRepository',
    'RtcTopologySnapshotRepository'
] as const;

const APP_INBOX_RECEIVER_FACTORIES = new Set(['readAppAuthInbox']);
const EXACT_APP_INBOX_RECEIVERS = new Set(['appAuthInbox']);

export const ALLOWED_DIRECT_BOUNDARY_CALLS = new Set([
    'exportBackupBundle',
    'exportDebugBundle',
    'findSnapshot',
    'listAfter',
    'listDocuments',
    'readConfig',
    'readOverride',
    'readSnapshot',
    'readTopologyView',
    'requireApiAdminSession',
    'requireApiAuthSession',
    'resetMetrics',
    'verifyIntegrity'
]);

export interface MutationBoundaryViolation {
    readonly filePath: string;
    readonly directMutatorCalls: readonly string[];
    readonly mutatingImports: readonly string[];
}

export function findMutationBoundaryViolationsFromRoots(
    roots: readonly string[]
): readonly MutationBoundaryViolation[] {
    return findMutationBoundaryViolationsFromRootFiles({
        roots,
        analyze: analyzeMutationBoundarySource
    });
}

export function analyzeMutationBoundarySource(
    source: string,
    filePath: string
): MutationBoundaryViolation {
    const program = parse(source, {
        sourceType: 'module',
        sourceFilename: filePath,
        createImportExpressions: true,
        plugins: ['typescript']
    }).program;
    const directMutatorCalls = new Set<string>();
    const mutatingImports = new Set<string>();
    const directAliases = new Map<string, string>();
    for (const call of findCapabilityMutationCalls(source, filePath)) {
        directMutatorCalls.add(call);
    }

    const root = decodeAstNode(program);
    if (root === undefined) {
        throw new TypeError(`${filePath} parsed without a program`);
    }
    walk(root, (node) => {
        if (node.type === 'ImportDeclaration') {
            readImportDeclaration(node, mutatingImports, directAliases);
            return;
        }
        if (node.type === 'ImportExpression') {
            const sourceValue = decodeAstStringLiteral(node.source);
            if (sourceValue && isForbiddenImportSource(sourceValue)) {
                mutatingImports.add(sourceValue);
            }
            return;
        }
        if (node.type === 'VariableDeclarator') {
            readDirectAliases(node, directAliases);
            return;
        }
        if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') {
            return;
        }
        const callee = decodeAstNode(node.callee);
        const callName = readCallName(callee, directAliases);
        if (callName && FORBIDDEN_DIRECT_MUTATORS.has(callName) && !isKnownAppInboxCall(callee)) {
            directMutatorCalls.add(callName);
        }
    });

    return {
        filePath,
        directMutatorCalls: [...directMutatorCalls].toSorted(),
        mutatingImports: [...mutatingImports].toSorted()
    };
}

function readImportDeclaration(
    node: MutationRoutingAstNode,
    mutatingImports: Set<string>,
    directAliases: Map<string, string>
): void {
    if (node.importKind === 'type') {
        return;
    }
    const source = decodeAstStringLiteral(node.source) ?? '';
    const forbiddenSource = isForbiddenImportSource(source);
    for (const rawSpecifier of decodeAstNodes(node.specifiers)) {
        if (rawSpecifier.importKind === 'type') {
            continue;
        }
        const imported = decodeAstName(rawSpecifier.imported);
        const local = decodeAstName(rawSpecifier.local);
        if (FORBIDDEN_MUTATING_IMPORTS.has(imported)) {
            mutatingImports.add(imported);
        }
        if (
            forbiddenSource &&
            (rawSpecifier.type === 'ImportDefaultSpecifier' ||
                rawSpecifier.type === 'ImportNamespaceSpecifier')
        ) {
            mutatingImports.add(local || source);
        }
        if (FORBIDDEN_DIRECT_MUTATORS.has(imported) && local) {
            directAliases.set(local, imported);
        }
    }
}

function readDirectAliases(node: MutationRoutingAstNode, aliases: Map<string, string>): void {
    const id = decodeAstNode(node.id);
    const init = decodeAstNode(node.init);
    if (!id || !init) {
        return;
    }
    if (id.type === 'Identifier') {
        const memberName = readMemberName(init);
        if (memberName && FORBIDDEN_DIRECT_MUTATORS.has(memberName)) {
            aliases.set(decodeAstName(id), memberName);
        }
        return;
    }
    if (id.type !== 'ObjectPattern') {
        return;
    }
    for (const property of decodeAstNodes(id.properties)) {
        const importedName = decodeAstName(property.key);
        if (!FORBIDDEN_DIRECT_MUTATORS.has(importedName)) {
            continue;
        }
        const local = decodeAstNode(property.value);
        const localName = local?.type === 'AssignmentPattern' ? decodeAstName(decodeAstNode(local.left)) : decodeAstName(local);
        if (localName) {
            aliases.set(localName, importedName);
        }
    }
}

function readCallName(node: MutationRoutingAstNode | undefined, aliases: Map<string, string>): string {
    if (!node) {
        return '';
    }
    if (node.type === 'Identifier') {
        const name = decodeAstName(node);
        return aliases.get(name) ?? name;
    }
    return readMemberName(node);
}

function readMemberName(node: MutationRoutingAstNode): string {
    if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') {
        return '';
    }
    return decodeAstName(node.property);
}

function isKnownAppInboxCall(callee: MutationRoutingAstNode | undefined): boolean {
    if (
        !callee ||
        (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression')
    ) {
        return false;
    }
    const receiver = decodeAstNode(callee.object);
    const receiverPath = readMemberPath(receiver);
    if (
        [...EXACT_APP_INBOX_RECEIVERS].some(
            (name) => receiverPath === name || receiverPath.endsWith(`.${name}`)
        )
    ) {
        return true;
    }
    if (
        !receiver ||
        (receiver.type !== 'CallExpression' && receiver.type !== 'OptionalCallExpression')
    ) {
        return false;
    }
    const factory = decodeAstNode(receiver.callee);
    return factory !== undefined && APP_INBOX_RECEIVER_FACTORIES.has(readMemberName(factory));
}

function readMemberPath(node: MutationRoutingAstNode | undefined): string {
    if (!node) {
        return '';
    }
    if (node.type === 'Identifier') {
        return decodeAstName(node);
    }
    if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') {
        return '';
    }
    const object = readMemberPath(decodeAstNode(node.object));
    const property = decodeAstName(node.property);
    return object && property ? `${object}.${property}` : '';
}

function isForbiddenImportSource(source: string): boolean {
    const fileName = source.split('/').at(-1) ?? source;
    return FORBIDDEN_IMPORT_STEMS.some((stem) => fileName.includes(stem));
}

function walk(node: MutationRoutingAstNode, visit: (node: MutationRoutingAstNode) => void): void {
    if (typeof node.type === 'string') {
        visit(node);
    }
    for (const [key, child] of Object.entries(node)) {
        if (['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) {
            continue;
        }
        const childNode = decodeAstNode(child);
        for (const descendant of childNode === undefined ? decodeAstNodes(child) : [childNode]) {
            walk(descendant, visit);
        }
    }
}

function decodeAstName(value: unknown): string {
    const node = decodeAstNode(value);
    if (!node) {
        return '';
    }
    return typeof node.name === 'string'
        ? node.name
        : typeof node.value === 'string'
        ? node.value
        : '';
}

function decodeAstStringLiteral(value: unknown): string | undefined {
    const node = decodeAstNode(value);
    return node && typeof node.value === 'string' ? node.value : undefined;
}

function decodeAstNode(value: unknown): MutationRoutingAstNode | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as MutationRoutingAstNode)
        : undefined;
}

function decodeAstNodes(value: unknown): readonly MutationRoutingAstNode[] {
    if (typeof value !== 'object' || value === null || !Array.isArray(value)) {
        return [];
    }
    return value.map(decodeAstNode).filter((node): node is MutationRoutingAstNode => node !== undefined);
}
