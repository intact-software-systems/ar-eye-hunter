import { Node, SyntaxKind } from 'ts-morph';

import {
    findProjectNodes,
    sortFacts,
    toOwnerDeclaration,
    toRepositoryPath,
    toResolvedSymbol,
    toSiteId,
    toTypeSymbols
} from './direct-write-sites.mjs';
import { isTransactionRooted } from './sql-write-facts.mjs';

const WRITE_PRIMITIVES = new Set([
    'deleteByKey',
    'deleteExpired',
    'deleteIfRevision',
    'insertIfAbsent',
    'upsert',
    'upsertIfRevision',
    'writeGuardedBatch'
]);

export function computeRepositoryWriteFacts(project, scope) {
    const calls = findProjectNodes(project, SyntaxKind.CallExpression);
    const writers = new Map();
    for (const call of calls.filter((candidate) => isRootRepositoryWrite(candidate, scope))) {
        addWriter(writers, call, scope);
    }
    let previousSize = -1;
    while (writers.size !== previousSize) {
        previousSize = writers.size;
        const writerNames = new Set([...writers.keys()].map(toDeclarationName).filter(Boolean));
        for (const call of calls.filter((candidate) => writerNames.has(toCalleeName(candidate)))) {
            const callees = toResolvedSymbol(toCalleeNameNode(call))?.getDeclarations() ?? [];
            if (callees.some((declaration) => writers.has(declaration))) {
                addWriter(writers, call, scope);
            }
        }
    }
    return toOwnerClassFacts(writers, scope);
}

function toOwnerClassFacts(writers, scope) {
    const counts = new Map();
    for (const [declaration, siteId] of writers) {
        const ownerClass = Node.isSourceFile(declaration) ? undefined : declaration.getFirstAncestor(isClass);
        const id = ownerClass === undefined
            ? siteId
            : `${toRepositoryPath(ownerClass.getSourceFile(), scope.root)}#${ownerClass.getName() ?? '<class>'}`;
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return sortFacts([...counts].map(([id, count]) => ({ id, count })));
}

function isClass(node) {
    return Node.isClassDeclaration(node) || Node.isClassExpression(node);
}

function isRootRepositoryWrite(call, scope) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || !WRITE_PRIMITIVES.has(callee.getName())) {
        return false;
    }
    const receiver = callee.getExpression();
    const contracts = new Set(scope.repositoryContractModules);
    return toTypeSymbols(receiver.getType()).some((symbol) =>
        symbol.getDeclarations().some((declaration) =>
            contracts.has(toRepositoryPath(declaration.getSourceFile(), scope.root))
        )
    ) && !isTransactionRooted(receiver);
}

function addWriter(writers, call, scope) {
    const owner = toOwnerDeclaration(call);
    const key = owner ?? call.getSourceFile();
    if (!writers.has(key)) {
        writers.set(key, toSiteId(call, scope.root));
    }
}

function toDeclarationName(declaration) {
    return typeof declaration.getName === 'function' ? declaration.getName() : undefined;
}

function toCalleeNameNode(call) {
    const callee = call.getExpression();
    return Node.isPropertyAccessExpression(callee) ? callee.getNameNode() : callee;
}

function toCalleeName(call) {
    const nameNode = toCalleeNameNode(call);
    return Node.isIdentifier(nameNode) ? nameNode.getText() : undefined;
}
