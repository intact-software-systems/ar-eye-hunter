import { Node, SyntaxKind } from 'ts-morph';

import { isExactType, unwrapExpression } from '../transaction-write-check/typescript-provenance.mjs';
import {
    sortFacts,
    toCountedFacts,
    toRepositoryPath,
    toResolvedSymbol,
    toSiteId
} from './direct-write-sites.mjs';
import { isTransactionOpenerCall } from './transaction-opener-facts.mjs';

const TRANSACTION_NAMES = new Set(['transaction', 'tx']);
const MAXIMUM_ROOT_DEPTH = 8;

export function computeSqlWriteFacts(project, scope) {
    const sqlWriteFiles = computeSqlWriteFileFacts(project, scope);
    const writeFiles = new Set(sqlWriteFiles.map((fact) => fact.id));
    return {
        sqlWriteFiles,
        nonTransactionHandleFeeds: computeHandleFeedFacts(project, scope, writeFiles)
    };
}

/** True when the handle derives from a transaction: a transaction parameter, an opener's callback, or a call on one. */
export function isTransactionRooted(expression, depth = 0) {
    const node = unwrapExpression(expression);
    if (depth > MAXIMUM_ROOT_DEPTH) {
        return false;
    }
    if (Node.isPropertyAccessExpression(node)) {
        return TRANSACTION_NAMES.has(node.getName());
    }
    if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
        return (node.getArguments() ?? []).some((argument) => isTransactionRooted(argument, depth + 1));
    }
    if (!Node.isIdentifier(node)) {
        return false;
    }
    return (toResolvedSymbol(node)?.getDeclarations() ?? []).some((declaration) =>
        isTransactionRootedDeclaration(declaration, depth)
    );
}

function isTransactionRootedDeclaration(declaration, depth) {
    if (Node.isParameterDeclaration(declaration)) {
        return TRANSACTION_NAMES.has(declaration.getName()) || isOpenerCallbackParameter(declaration);
    }
    if (Node.isVariableDeclaration(declaration) && declaration.getInitializer() !== undefined) {
        return isTransactionRooted(declaration.getInitializer(), depth + 1);
    }
    return false;
}

function isOpenerCallbackParameter(parameter) {
    const callback = parameter.getParent();
    const call = callback.getParent();
    return (Node.isArrowFunction(callback) || Node.isFunctionExpression(callback)) &&
        Node.isCallExpression(call) &&
        isTransactionOpenerCall(call);
}

function computeSqlWriteFileFacts(project, scope) {
    const tables = new Set(scope.schemaTables);
    const facts = project.getSourceFiles().filter(mayHoldWriteStatement).flatMap((sourceFile) => {
        const statements = new Set(
            findSqlLiterals(sourceFile)
                .filter((literal) => !isTransactionTaggedTemplate(literal))
                .flatMap((literal) => toWriteStatements(toLiteralText(literal), tables))
        );
        return statements.size === 0
            ? []
            : [{ id: toRepositoryPath(sourceFile, scope.root), statements: [...statements].toSorted() }];
    });
    return sortFacts(facts);
}

/** Wrapping every node of every file is the cost; a file whose text holds no write keyword holds no write literal. */
function mayHoldWriteStatement(sourceFile) {
    return WRITE_KEYWORD.test(sourceFile.getFullText());
}

function findSqlLiterals(sourceFile) {
    return [
        ...sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral),
        ...sourceFile.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
        ...sourceFile.getDescendantsOfKind(SyntaxKind.TemplateExpression)
    ].filter((literal) =>
        !Node.isImportDeclaration(literal.getParent()) && !Node.isExportDeclaration(literal.getParent())
    );
}

function isTransactionTaggedTemplate(literal) {
    const tagged = literal.getParent();
    if (!Node.isTaggedTemplateExpression(tagged) || tagged.getTemplate() !== literal) {
        return false;
    }
    const tag = tagged.getTag();
    return Node.isIdentifier(tag) &&
        isExactType(tag, 'PSqlSql') &&
        (toResolvedSymbol(tag)?.getDeclarations() ?? []).some((declaration) =>
            Node.isParameterDeclaration(declaration) && TRANSACTION_NAMES.has(declaration.getName())
        );
}

function toLiteralText(literal) {
    if (!Node.isTemplateExpression(literal)) {
        return literal.getLiteralText();
    }
    return [
        literal.getHead().getLiteralText(),
        ...literal.getTemplateSpans().map((span) => span.getLiteral().getLiteralText())
    ]
        .join(' $ ');
}

function toWriteStatements(text, tables) {
    const statements = [];
    for (const [operation, pattern] of WRITE_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
            if (tables.has(match[1].toLowerCase())) {
                statements.push(`${operation}:${match[1].toLowerCase()}`);
            }
        }
    }
    if (/\bselect\b/iu.test(text)) {
        for (const match of text.matchAll(LOCK_PATTERN)) {
            const table = match[1]?.toLowerCase();
            statements.push(tables.has(table) ? `lock:${table}` : 'lock');
        }
    }
    return statements;
}

const WRITE_PATTERNS = [
    ['insert', /\binsert\s+into\s+([a-z_][a-z0-9_]*)/giu],
    ['update', /\bupdate\s+([a-z_][a-z0-9_]*)\s+(?:as\s+[a-z_][a-z0-9_]*\s+|[a-z_][a-z0-9_]*\s+)?set\b/giu],
    ['delete', /\bdelete\s+from\s+([a-z_][a-z0-9_]*)/giu],
    ['truncate', /\btruncate\s+(?:table\s+)?([a-z_][a-z0-9_]*)/giu],
    ['merge', /\bmerge\s+into\s+([a-z_][a-z0-9_]*)/giu]
];
const WRITE_KEYWORD = /\b(?:insert\s+into|update|delete\s+from|truncate|merge\s+into)\b/iu;
const LOCK_PATTERN = /\bfor\s+(?:no\s+key\s+)?update(?:\s+of\s+([a-z_][a-z0-9_]*))?/giu;

function computeHandleFeedFacts(project, scope, writeFiles) {
    const siteIds = project.getSourceFiles()
        .filter((sourceFile) => !writeFiles.has(toRepositoryPath(sourceFile, scope.root)))
        .flatMap((sourceFile) => [
            ...sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression),
            ...sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)
        ])
        .filter((invocation) => feedsRootHandleIntoWrite(invocation, scope, writeFiles))
        .map((invocation) => toSiteId(invocation, scope.root));
    return toCountedFacts(siteIds);
}

function feedsRootHandleIntoWrite(invocation, scope, writeFiles) {
    const candidates = (invocation.getArguments() ?? []).filter((argument) => !isLiteralOrCallback(argument));
    if (candidates.length === 0) {
        return false;
    }
    const callees = toCalleeDeclarations(invocation);
    const declaredInWriteFile = callees.some((declaration) =>
        writeFiles.has(toRepositoryPath(declaration.getSourceFile(), scope.root))
    );
    return candidates.some((argument) => {
        const index = invocation.getArguments().indexOf(argument);
        return (declaredInWriteFile || callees.some((declaration) => isTransactionParameterAt(declaration, index))) &&
            isRootHandle(argument);
    });
}

function isLiteralOrCallback(argument) {
    const node = unwrapExpression(argument);
    return Node.isLiteralExpression(node) ||
        Node.isTemplateExpression(node) ||
        Node.isArrowFunction(node) ||
        Node.isFunctionExpression(node) ||
        Node.isObjectLiteralExpression(node) ||
        Node.isArrayLiteralExpression(node);
}

function isRootHandle(argument) {
    const node = unwrapExpression(argument);
    return isExactType(node, 'PSqlSql') && !isTransactionRooted(node);
}

function toCalleeDeclarations(invocation) {
    const callee = invocation.getExpression();
    const nameNode = Node.isPropertyAccessExpression(callee) ? callee.getNameNode() : callee;
    const declarations = toResolvedSymbol(nameNode)?.getDeclarations() ?? [];
    return declarations.flatMap((declaration) =>
        Node.isClassDeclaration(declaration) ? declaration.getConstructors() : [declaration]
    );
}

function isTransactionParameterAt(declaration, index) {
    const target = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : declaration;
    const parameter = typeof target?.getParameters === 'function' ? target.getParameters()[index] : undefined;
    return parameter !== undefined && TRANSACTION_NAMES.has(parameter.getName());
}
