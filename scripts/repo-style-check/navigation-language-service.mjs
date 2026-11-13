import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let memoizedTsMorph;

// ts-morph's getDefinitionNodes() and findReferencesAsNodes() wrap every answer in an object that
// subscribes to its source file's next modification. The checker never modifies a file, so each
// subscription lives as long as the project and each new one scans the whole list. These readers
// ask the language service the same question and map each answer to the node ts-morph 28 returns.
// An answer naming a file the project has not loaded goes back to ts-morph, because loading a file
// changes the program.

export function readDefinitionNodes(identifier) {
    const project = identifier.getProject();
    const definitions = project.getLanguageService().compilerObject.getDefinitionAtPosition(
        identifier.getSourceFile().getFilePath(),
        identifier.getStart()
    ) || [];
    const sourceFiles = readLoadedSourceFiles(project, definitions);
    if (sourceFiles === undefined) {
        return identifier.getDefinitionNodes();
    }
    return definitions
        .map((definition, index) => toDeclarationNode(sourceFiles[index], definition))
        .filter((declaration) => declaration != null);
}

export function readReferenceNodes(node) {
    const project = node.getProject();
    const target = toReferenceTarget(node);
    const referencedSymbols = project.getLanguageService().compilerObject.findReferences(
        target.getSourceFile().getFilePath(),
        target.getStart()
    ) || [];
    const spans = referencedSymbols.flatMap((symbol) => [symbol.definition, ...symbol.references]);
    if (readLoadedSourceFiles(project, spans) === undefined) {
        return node.findReferencesAsNodes();
    }
    return referencedSymbols.flatMap((symbol) => {
        const isAlias = symbol.definition.kind === 'alias';
        return symbol.references
            .filter((reference, index) => isAlias || !reference.isDefinition || index > 0)
            .map((reference) => toSpanNode(project, project.getSourceFile(reference.fileName), reference.textSpan));
    });
}

function readLoadedSourceFiles(project, spans) {
    const sourceFiles = spans.map((span) => project.getSourceFile(span.fileName));
    return sourceFiles.includes(undefined) ? undefined : sourceFiles;
}

function toDeclarationNode(sourceFile, definition) {
    if (definition.kind === 'module' && definition.textSpan.length === sourceFile.getFullWidth()) {
        return sourceFile;
    }
    return findIdentifierAt(sourceFile, definition.textSpan.start)?.getParentOrThrow();
}

function findIdentifierAt(sourceFile, start) {
    const { Node } = readTsMorph();
    let node = sourceFile;
    while (node !== undefined) {
        if (Node.isIdentifier(node) && node.getStart() === start) {
            return node;
        }
        node = node.getChildAtPos(start);
    }
    return undefined;
}

function toReferenceTarget(node) {
    const { Node } = readTsMorph();
    if (Node.isIdentifier(node) || Node.isStringLiteral(node)) {
        return node;
    }
    const nameNode = node.getNodeProperty('name');
    if (nameNode != null) {
        return nameNode;
    }
    if (Node.isExportable(node)) {
        return node.getDefaultKeyword() || node;
    }
    return node;
}

// ts-morph compares a node's width with the span's end offset and keeps the outermost node it
// walked through when nothing matches; the same comparison keeps the same nodes.
function toSpanNode(project, sourceFile, textSpan) {
    const start = textSpan.start;
    const end = textSpan.start + textSpan.length;
    let bestNode;
    project.forgetNodesCreatedInBlock((remember) => {
        let foundNode;
        let nextNode = sourceFile;
        while (nextNode != null) {
            if (foundNode == null) {
                bestNode = nextNode;
            }
            if (nextNode.getStart() === start && nextNode.getWidth() === end) {
                bestNode = foundNode = nextNode;
            }
            else if (foundNode != null) {
                break;
            }
            nextNode = nextNode.getChildAtPos(start);
        }
        if (bestNode != null) {
            remember(bestNode);
        }
    });
    return bestNode;
}

function readTsMorph() {
    memoizedTsMorph ??= require('ts-morph');
    return memoizedTsMorph;
}
