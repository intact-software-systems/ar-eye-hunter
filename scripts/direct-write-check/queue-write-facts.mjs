import { Node, SyntaxKind } from 'ts-morph';

import { findProjectNodes, sortFacts, toRepositoryPath, toSiteId, toTypeSymbols } from './direct-write-sites.mjs';

/** The queue API's row writes, claims and releases; AppInbox, its workers and the ALM stores all go through them. */
const QUEUE_WRITE_METHODS = new Set([
    'enqueue',
    'enqueueIfAbsent',
    'releaseEntries',
    'replaceIfObserved',
    'reserveEntries',
    'reserveOverdueRetryEntries',
    'reserveRetryExhaustionFinalizations',
    'reserveTimeoutEntries',
    'writeIfAbsent'
]);
const QUEUE_PACKAGES = ['packages/shared/queuebox/', 'packages/shared-server/queuebox/'];

/** Owners that call a queue write method on a receiver whose type the queue packages declare, by method. */
export function computeQueueWriteFacts(project, scope) {
    const methodsById = new Map();
    for (const call of findProjectNodes(project, SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        if (
            Node.isPropertyAccessExpression(callee) &&
            QUEUE_WRITE_METHODS.has(callee.getName()) &&
            isQueueTypedReceiver(callee.getExpression(), scope)
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
        symbol.getDeclarations().some((declaration) =>
            QUEUE_PACKAGES.some((queuePackage) =>
                toRepositoryPath(declaration.getSourceFile(), scope.root).startsWith(queuePackage)
            )
        )
    );
}
