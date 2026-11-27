import { Node, SyntaxKind } from 'ts-morph';

import { isExactType } from '../transaction-write-check/typescript-provenance.mjs';
import {
    findProjectNodes,
    isCallableArgument,
    toCountedFacts,
    toSiteId
} from './direct-write-sites.mjs';

const OPENER_METHODS = new Set(['begin', 'savepoint', 'transaction']);
const OPENER_FUNCTION = 'runInPSqlTransaction';

export function computeTransactionOpenerFacts(project, scope) {
    const siteIds = findProjectNodes(project, SyntaxKind.CallExpression)
        .filter(isTransactionOpenerCall)
        .map((call) => toSiteId(call, scope.root));
    return toCountedFacts(siteIds);
}

/**
 * A deliberately syntactic superset: any call of an opener name that hands over a callback, so an
 * opener on an interface-typed repository or a driver wrapper is not lost to type resolution.
 */
export function isTransactionOpenerCall(call) {
    const callee = call.getExpression();
    const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
    const isOpenerName = Node.isPropertyAccessExpression(callee)
        ? OPENER_METHODS.has(name) || name === OPENER_FUNCTION
        : name === OPENER_FUNCTION;
    if (!isOpenerName || !call.getArguments().some(isCallableArgument)) {
        return false;
    }
    return !Node.isPropertyAccessExpression(callee) || !isExactType(callee.getExpression(), 'IDBDatabase');
}
