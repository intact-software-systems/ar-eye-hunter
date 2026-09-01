import { createRequire } from 'node:module';

import { findUnknownUsages } from './contract-rules.mjs';
import { resolveFunctionNameAtLine } from './function-analysis.mjs';

const require = createRequire(import.meta.url);
const displayedFindingCount = 5;
const ruleId = 'boundary.unknown';
let memoizedTypeScript;

export function scanBoundaryUnknownFindings(raw) {
    const rawUsages = findUnknownUsages(raw.split('\n'));
    if (rawUsages.length === 0) {
        return [];
    }

    const normalizedBoundaryOffsets = findNormalizedBoundaryOffsets(raw);
    const usages = rawUsages
        .filter(({ offset }) => !normalizedBoundaryOffsets.has(offset))
        .map((usage) => ({
            ...usage,
            symbol: resolveFunctionNameAtLine(raw, usage.line)
        }));
    const findings = usages.slice(0, displayedFindingCount).map(toDetailFinding);
    const remainingCountBySymbol = countBySymbol(usages.slice(displayedFindingCount));

    for (const [symbol, count] of remainingCountBySymbol) {
        findings.push({
            affectedCount: count,
            ruleId,
            symbol,
            message: `... and ${count} additional unknown occurrence${count === 1 ? '' : 's'} ` +
                'for this owner. Reduce unknown propagation at domain boundaries.'
        });
    }
    return findings;
}

function findNormalizedBoundaryOffsets(raw) {
    const typescript = readTypeScript();
    const sourceFile = typescript.createSourceFile(
        'boundary-unknown-analysis.ts',
        raw,
        typescript.ScriptTarget.Latest,
        true,
        typescript.ScriptKind.TS
    );
    const context = { sourceFile, typescript };
    const offsets = new Set();
    const visit = (node) => {
        if (
            node.kind === typescript.SyntaxKind.UnknownKeyword &&
            isNormalizedBoundaryUnknown(node, context)
        ) {
            offsets.add(node.getStart(sourceFile));
        }
        typescript.forEachChild(node, visit);
    };
    visit(sourceFile);
    return offsets;
}

function isNormalizedBoundaryUnknown(unknownNode, context) {
    const { sourceFile, typescript } = context;
    const parameter = findAncestor(unknownNode.parent, typescript.isParameter);
    if (parameter?.type !== unknownNode || !typescript.isIdentifier(parameter.name)) {
        return false;
    }

    const callable = parameter.parent;
    if (typescript.isFunctionTypeNode(callable)) {
        return isDecoderTypeContract(callable, typescript);
    }
    if (!isCallableDeclaration(callable, typescript)) {
        return false;
    }

    const returnType = callable.type;
    if (returnType === undefined) {
        return false;
    }

    const body = callable.body;
    if (body === undefined) {
        return isDeclaredDecoderContract(callable, typescript);
    }

    const name = callableName(callable, sourceFile, typescript);
    const isDecoder = /^decode(?:[A-Z0-9_]|$)/u.test(name);
    const isTypeGuard = typescript.isTypePredicateNode(returnType);
    return (
        (isDecoder || isTypeGuard) &&
        bodyNarrowsParameter(body, parameter.name.text, context)
    );
}

function isDecoderTypeContract(callable, typescript) {
    const alias = findAncestor(callable.parent, typescript.isTypeAliasDeclaration);
    const callbackParameter = findAncestor(callable.parent, typescript.isParameter);
    return (
        callable.type !== undefined &&
        (alias !== undefined && /Decoder$/u.test(alias.name.text) ||
            callbackParameter?.type === callable &&
                typescript.isIdentifier(callbackParameter.name) &&
                /^decode(?:[A-Z0-9_]|$)/u.test(callbackParameter.name.text))
    );
}

function isCallableDeclaration(node, typescript) {
    return (
        typescript.isArrowFunction(node) ||
        typescript.isFunctionDeclaration(node) ||
        typescript.isFunctionExpression(node) ||
        typescript.isMethodDeclaration(node)
    );
}

function isDeclaredDecoderContract(callable, typescript) {
    if (!typescript.isFunctionDeclaration(callable)) {
        return false;
    }
    return (
        callable.name !== undefined &&
        /^decode(?:[A-Z0-9_]|$)/u.test(callable.name.text)
    );
}

function callableName(callable, sourceFile, typescript) {
    if ('name' in callable && callable.name !== undefined) {
        return callable.name.getText(sourceFile);
    }
    if (
        (typescript.isArrowFunction(callable) || typescript.isFunctionExpression(callable)) &&
        typescript.isVariableDeclaration(callable.parent) &&
        typescript.isIdentifier(callable.parent.name)
    ) {
        return callable.parent.name.text;
    }
    return '';
}

function bodyNarrowsParameter(body, parameterName, context) {
    const { sourceFile, typescript } = context;
    let narrows = false;
    const visit = (node) => {
        if (narrows) {
            return;
        }
        if (
            typescript.isTypeOfExpression(node) &&
            node.expression.getText(sourceFile) === parameterName
        ) {
            narrows = true;
            return;
        }
        if (
            typescript.isBinaryExpression(node) &&
            binaryExpressionNarrowsParameter(node, parameterName, context)
        ) {
            narrows = true;
            return;
        }
        if (
            typescript.isCallExpression(node) &&
            callNarrowsParameter(node, parameterName, context)
        ) {
            narrows = true;
            return;
        }
        typescript.forEachChild(node, visit);
    };
    typescript.forEachChild(body, visit);
    return narrows;
}

function binaryExpressionNarrowsParameter(expression, parameterName, context) {
    const { sourceFile, typescript } = context;
    const left = expression.left.getText(sourceFile);
    const right = expression.right.getText(sourceFile);
    const operator = expression.operatorToken.kind;
    const comparisonOperators = new Set([
        typescript.SyntaxKind.EqualsEqualsEqualsToken,
        typescript.SyntaxKind.EqualsEqualsToken,
        typescript.SyntaxKind.ExclamationEqualsEqualsToken,
        typescript.SyntaxKind.ExclamationEqualsToken,
        typescript.SyntaxKind.InstanceOfKeyword
    ]);
    return (
        comparisonOperators.has(operator) &&
        ((left === parameterName && isBoundaryComparisonValue(right)) ||
            (right === parameterName && isBoundaryComparisonValue(left)))
    );
}

function isBoundaryComparisonValue(text) {
    return text === 'null' || text === 'undefined' || /^[A-Z][A-Za-z0-9_$]*$/u.test(text);
}

function callNarrowsParameter(call, parameterName, context) {
    const { sourceFile, typescript } = context;
    const calleeName = call.expression
        .getText(sourceFile)
        .split('.')
        .at(-1);
    if (!/^(?:assert|decode|ensure|is|read|require|validate)(?:[A-Z0-9_]|$)/u.test(calleeName)) {
        return false;
    }
    return call.arguments.some((argument) => expressionReferencesName(argument, parameterName, typescript));
}

function expressionReferencesName(expression, name, typescript) {
    let references = typescript.isIdentifier(expression) && expression.text === name;
    const visit = (node) => {
        if (references) {
            return;
        }
        if (typescript.isIdentifier(node) && node.text === name) {
            references = true;
            return;
        }
        typescript.forEachChild(node, visit);
    };
    typescript.forEachChild(expression, visit);
    return references;
}

function findAncestor(node, predicate) {
    for (let current = node; current !== undefined; current = current.parent) {
        if (predicate(current)) {
            return current;
        }
    }
    return undefined;
}

function readTypeScript() {
    memoizedTypeScript ??= require('ts-morph').ts;
    return memoizedTypeScript;
}

function toDetailFinding(usage) {
    return {
        ruleId,
        symbol: usage.symbol,
        message: `Review unknown at line ${usage.line}: ${usage.text} ` +
            'Keep it at an untrusted boundary and normalize it before domain logic.'
    };
}

function countBySymbol(usages) {
    const countByOwner = new Map();
    for (const usage of usages) {
        countByOwner.set(usage.symbol, (countByOwner.get(usage.symbol) ?? 0) + 1);
    }
    return countByOwner;
}
