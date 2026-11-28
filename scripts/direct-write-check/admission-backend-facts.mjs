import { Node, SyntaxKind } from 'ts-morph';

import { isExactType } from '../transaction-write-check/typescript-provenance.mjs';
import {
    findProjectNodes,
    sortFacts,
    toCountedFacts,
    toRepositoryPath,
    toResolvedSymbol,
    toSiteId,
    toTypeSymbols
} from './direct-write-sites.mjs';

const ADMISSION_PORT_NAMES = new Set(['ALAdmissionBackend', 'ALAdmissionWorkBackend']);
const ALM_PACKAGE = 'packages/shared/alm/';
const ROW_KEY_BUILDER = /^toAL\w*(?:Key|Prefix)$/u;

export function computeAdmissionBackendFacts(project, scope) {
    const implementations = findAdmissionBackendClasses(project, scope);
    const postgresClasses = new Set(
        implementations.filter((implementation) => implementation.backend === 'postgres')
            .map((implementation) => implementation.declaration)
    );
    const implementationClasses = new Set(implementations.map((implementation) => implementation.declaration));
    return {
        admissionBackendImplementations: sortFacts(
            implementations.map(({ id, backend }) => ({ id, backend }))
        ),
        admissionBackendConstructions: computeConstructionFacts(project, scope, postgresClasses),
        admissionBackendWrites: computeWriteFacts(project, scope, implementationClasses),
        wiringImports: computeWiringImportFacts(project, scope),
        rowFamilies: computeRowFamilyFacts(project, scope)
    };
}

function findAdmissionBackendClasses(project, scope) {
    return project.getSourceFiles()
        .flatMap((sourceFile) => sourceFile.getDescendantsOfKind(SyntaxKind.ClassDeclaration))
        .filter((declaration) =>
            declaration.getImplements().some((heritage) =>
                isAdmissionPortSymbol(toResolvedSymbol(heritage.getExpression()), scope)
            )
        )
        .map((declaration) => ({
            declaration,
            id: `${toRepositoryPath(declaration.getSourceFile(), scope.root)}#${declaration.getName()}`,
            backend: holdsPostgresHandle(declaration) ? 'postgres' : 'not-postgres'
        }));
}

function holdsPostgresHandle(declaration) {
    const parameterProperties = declaration.getConstructors()
        .flatMap((constructor) => constructor.getParameters())
        .filter((parameter) => parameter.isParameterProperty());
    return [...declaration.getProperties(), ...parameterProperties]
        .some((member) => isExactType(member, 'PSqlSql'));
}

function computeConstructionFacts(project, scope, postgresClasses) {
    const namespacesById = new Map();
    for (const construction of findProjectNodes(project, SyntaxKind.NewExpression)) {
        const declarations = toResolvedSymbol(construction.getExpression())?.getDeclarations() ?? [];
        if (!declarations.some((declaration) => postgresClasses.has(declaration))) {
            continue;
        }
        const id = toSiteId(construction, scope.root);
        namespacesById.set(id, [...(namespacesById.get(id) ?? []), toNamespaceText(construction)]);
    }
    return sortFacts(
        [...namespacesById].map(([id, namespaces]) => ({
            id,
            count: namespaces.length,
            namespaces: namespaces.toSorted()
        }))
    );
}

function toNamespaceText(construction) {
    const input = construction.getArguments()[0];
    if (!Node.isObjectLiteralExpression(input)) {
        return input?.getText() ?? '<no input>';
    }
    const property = input.getProperty('namespace');
    if (Node.isShorthandPropertyAssignment(property)) {
        return toLocalInitializerText(property.getValueSymbol(), property.getText());
    }
    if (!Node.isPropertyAssignment(property)) {
        return property?.getText() ?? '<no namespace>';
    }
    const initializer = property.getInitializerOrThrow();
    return Node.isIdentifier(initializer)
        ? toLocalInitializerText(initializer.getSymbol(), initializer.getText())
        : initializer.getText();
}

function toLocalInitializerText(symbol, fallback) {
    const declaration = symbol?.getDeclarations().find((candidate) => Node.isVariableDeclaration(candidate));
    return declaration?.getInitializer()?.getText() ?? fallback;
}

function computeWriteFacts(project, scope, implementationClasses) {
    const siteIds = findProjectNodes(project, SyntaxKind.CallExpression)
        .filter((call) => {
            const callee = call.getExpression();
            return Node.isPropertyAccessExpression(callee) &&
                callee.getName() === 'write' &&
                isAdmissionPortReceiver(callee.getExpression(), scope, implementationClasses);
        })
        .map((call) => toSiteId(call, scope.root));
    return toCountedFacts(siteIds);
}

function isAdmissionPortReceiver(receiver, scope, implementationClasses) {
    return toTypeSymbols(receiver.getType()).some((symbol) =>
        isAdmissionPortSymbol(symbol, scope) ||
        symbol.getDeclarations().some((declaration) => implementationClasses.has(declaration))
    );
}

function isAdmissionPortSymbol(symbol, scope) {
    return symbol !== undefined &&
        ADMISSION_PORT_NAMES.has(symbol.getName()) &&
        symbol.getDeclarations().some((declaration) =>
            toRepositoryPath(declaration.getSourceFile(), scope.root).startsWith(ALM_PACKAGE)
        );
}

function computeWiringImportFacts(project, scope) {
    const wiringModules = new Set(scope.wiringModules);
    const facts = project.getSourceFiles().flatMap((sourceFile) =>
        sourceFile.getImportDeclarations()
            .filter((declaration) => !isTypeOnlyImport(declaration))
            .map((declaration) => declaration.getModuleSpecifierSourceFile())
            .filter((target) => target !== undefined && wiringModules.has(toRepositoryPath(target, scope.root)))
            .map((target) => ({
                id: `${toRepositoryPath(sourceFile, scope.root)}#import:${toRepositoryPath(target, scope.root)}`
            }))
    );
    return sortFacts(facts);
}

function computeRowFamilyFacts(project, scope) {
    const topicConstants = new Map(scope.workTopicConstants.map((topic) => [topic.path, topic.name]));
    const facts = project.getSourceFiles().flatMap((sourceFile) => {
        const repositoryPath = toRepositoryPath(sourceFile, scope.root);
        const keyBuilders = repositoryPath.startsWith(ALM_PACKAGE)
            ? toKeyBuilderNames(sourceFile).map((name) => `${repositoryPath}#${name}`)
            : [];
        const topicName = topicConstants.get(repositoryPath);
        return [
            ...keyBuilders,
            ...(topicName === undefined ? [] : toWorkTopicIds(sourceFile, repositoryPath, topicName))
        ];
    });
    return sortFacts(facts.map((id) => ({ id })));
}

/** Exported `toAL...Key` and `toAL...Prefix` builders, declared as functions or as function-valued constants. */
function toKeyBuilderNames(sourceFile) {
    const functions = sourceFile.getFunctions()
        .filter((declaration) => declaration.isExported())
        .map((declaration) => declaration.getName() ?? '');
    const constants = sourceFile.getVariableStatements()
        .filter((statement) => statement.isExported())
        .flatMap((statement) => statement.getDeclarations())
        .filter((declaration) => {
            const initializer = declaration.getInitializer();
            return Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer);
        })
        .map((declaration) => declaration.getName());
    return [...functions, ...constants].filter((name) => ROW_KEY_BUILDER.test(name));
}

function toWorkTopicIds(sourceFile, repositoryPath, constantName) {
    const initializer = sourceFile.getVariableDeclaration(constantName)?.getInitializer();
    return (initializer?.getDescendantsOfKind(SyntaxKind.StringLiteral) ?? [])
        .map((literal) => `${repositoryPath}#${constantName}.${literal.getLiteralText()}`);
}

function isTypeOnlyImport(declaration) {
    if (declaration.isTypeOnly()) {
        return true;
    }
    const named = declaration.getNamedImports();
    return declaration.getDefaultImport() === undefined &&
        declaration.getNamespaceImport() === undefined &&
        named.length > 0 &&
        named.every((specifier) => specifier.isTypeOnly());
}
