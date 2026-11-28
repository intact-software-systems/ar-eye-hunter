import { Node, SyntaxKind } from 'ts-morph';

import {
    findProjectNodes,
    sortFacts,
    toRepositoryPath,
    toResolvedSymbol,
    toSiteId,
    toTypeSymbols
} from './direct-write-sites.mjs';

/** The queue API's row writes, claims and releases; AppInbox, its workers and the ALM stores all go through them. */
const QUEUE_WRITE_METHODS = new Set([
    'deleteExpired',
    'enqueue',
    'enqueueIfAbsent',
    'releaseEntries',
    'removeItem',
    'replaceIfObserved',
    'reserveEntries',
    'reserveOverdueRetryEntries',
    'reserveRetryExhaustionFinalizations',
    'reserveTimeoutEntries',
    'setItem',
    'writeIfAbsent'
]);
const QUEUE_PACKAGES = ['packages/shared/queuebox/', 'packages/shared-server/queuebox/'];

/** Owners that call a queue write method whose receiver type or method declaration the queue packages hold, by method. */
export function computeQueueWriteFacts(project, scope) {
    const methodsById = new Map();
    for (const call of findProjectNodes(project, SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        if (
            Node.isPropertyAccessExpression(callee) &&
            QUEUE_WRITE_METHODS.has(callee.getName()) &&
            (isQueueTypedReceiver(callee.getExpression(), scope) || isQueueDeclaredMethod(callee, scope))
        ) {
            const id = toSiteId(call, scope.root);
            methodsById.set(id, [...(methodsById.get(id) ?? []), callee.getName()]);
        }
    }
    return sortFacts(
        [...methodsById].map(([id, methods]) => ({
            id,
            count: methods.length,
            methods: [...new Set(methods)].toSorted()
        }))
    );
}

function isQueueTypedReceiver(receiver, scope) {
    return toTypeSymbols(receiver.getType()).some((symbol) =>
        symbol.getDeclarations().some((declaration) => isInQueuePackage(declaration, scope))
    );
}

/** A narrowed receiver such as `Pick<EnqueueResourceEntryController, 'enqueueIfAbsent'>` keeps its method's declaration. */
function isQueueDeclaredMethod(callee, scope) {
    return (toResolvedSymbol(callee.getNameNode())?.getDeclarations() ?? []).some((declaration) =>
        isInQueuePackage(declaration, scope)
    );
}

function isInQueuePackage(declaration, scope) {
    return QUEUE_PACKAGES.some((queuePackage) =>
        toRepositoryPath(declaration.getSourceFile(), scope.root).startsWith(queuePackage)
    );
}
