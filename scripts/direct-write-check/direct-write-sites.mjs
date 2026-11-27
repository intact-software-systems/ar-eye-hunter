import path from 'node:path';
import { Node } from 'ts-morph';

export function toRepositoryPath(sourceFile, root) {
    return path.posix.relative(root.replaceAll('\\', '/'), sourceFile.getFilePath().replaceAll('\\', '/'));
}

export function toSiteId(node, root) {
    return `${toRepositoryPath(node.getSourceFile(), root)}#${toOwnerName(node)}`;
}

export function toOwnerName(node) {
    const names = node.getAncestors().toReversed().map(toOwnerSegment).filter((name) => name !== undefined);
    return names.length === 0 ? '<module>' : names.join('.');
}

export function toCountedFacts(siteIds) {
    const counts = new Map();
    for (const id of siteIds) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return sortFacts([...counts].map(([id, count]) => ({ id, count })));
}

export function sortFacts(facts) {
    return facts.toSorted((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function toResolvedSymbol(node) {
    const symbol = node.getSymbol();
    return symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol;
}

export function toTypeSymbols(type) {
    const constituents = [type, ...type.getUnionTypes(), ...type.getIntersectionTypes()];
    return constituents
        .flatMap((constituent) => [constituent.getAliasSymbol(), constituent.getSymbol()])
        .filter((symbol) => symbol !== undefined)
        .map((symbol) => symbol.isAlias() ? symbol.getAliasedSymbol() : symbol);
}

export function isCallableArgument(argument) {
    return Node.isArrowFunction(argument) ||
        Node.isFunctionExpression(argument) ||
        argument.getType().getCallSignatures().length > 0;
}

function toOwnerSegment(ancestor) {
    if (Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor)) {
        return ancestor.getName() ?? '<class>';
    }
    if (Node.isConstructorDeclaration(ancestor)) {
        return 'constructor';
    }
    if (
        Node.isMethodDeclaration(ancestor) ||
        Node.isFunctionDeclaration(ancestor) ||
        Node.isGetAccessorDeclaration(ancestor) ||
        Node.isSetAccessorDeclaration(ancestor)
    ) {
        return ancestor.getName() ?? '<function>';
    }
    if (
        (Node.isVariableDeclaration(ancestor) ||
            Node.isPropertyAssignment(ancestor) ||
            Node.isPropertyDeclaration(ancestor)) &&
        isFunctionInitializer(ancestor.getInitializer())
    ) {
        return ancestor.getName();
    }
    return undefined;
}

function isFunctionInitializer(initializer) {
    return initializer !== undefined && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer));
}
