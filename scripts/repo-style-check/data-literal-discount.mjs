import { createRequire } from 'node:module';

// ts-morph loads lazily via require so this discount is only paid by files
// already over the navigation backstop; every other checker run never loads it.
const require = createRequire(import.meta.url);

let memoizedTsMorph;
let memoizedProject;

// Counts code lines covered by behavior-free object/array literals spanning at
// least three lines. Blank, comment, close-only, and import lines inside a
// literal are classified first and never double-counted, so the discount
// mirrors the calibration lab's line profile exactly.
export function computeDataLiteralLineCount(file, raw) {
    const project = readAnalysisProject();
    const sourceFile = project.createSourceFile(
        `data-literal/${file.replaceAll('/', '__').replaceAll('\\', '__')}`,
        raw,
        { overwrite: true }
    );
    try {
        const lineKinds = classifyPhysicalLines(raw.split('\n'));
        markImportLines(sourceFile, lineKinds);
        markDataLiteralLines(sourceFile, lineKinds);
        return lineKinds.filter((kind) => kind === 'data').length;
    }
    finally {
        project.removeSourceFile(sourceFile);
    }
}

function readTsMorph() {
    memoizedTsMorph ??= require('ts-morph');
    return memoizedTsMorph;
}

function readAnalysisProject() {
    const { Project } = readTsMorph();
    memoizedProject ??= new Project({
        skipAddingFilesFromTsConfig: true,
        skipFileDependencyResolution: true
    });
    return memoizedProject;
}

function classifyPhysicalLines(lines) {
    const lineKinds = new Array(lines.length + 1).fill('code');
    let insideBlockComment = false;
    for (let index = 0; index < lines.length; index += 1) {
        const trimmed = lines[index].trim();
        const lineNumber = index + 1;
        if (insideBlockComment) {
            lineKinds[lineNumber] = 'comment';
            if (trimmed.includes('*/')) {
                insideBlockComment = false;
            }
            continue;
        }
        if (trimmed === '') {
            lineKinds[lineNumber] = 'blank';
            continue;
        }
        if (trimmed.startsWith('//')) {
            lineKinds[lineNumber] = 'comment';
            continue;
        }
        if (trimmed.startsWith('/*')) {
            lineKinds[lineNumber] = 'comment';
            if (!trimmed.includes('*/')) {
                insideBlockComment = true;
            }
            continue;
        }
        if (/^[}\])]+[;,]?$/u.test(trimmed)) {
            lineKinds[lineNumber] = 'close';
        }
    }
    return lineKinds;
}

function markImportLines(sourceFile, lineKinds) {
    for (
        const declaration of [
            ...sourceFile.getImportDeclarations(),
            ...sourceFile.getExportDeclarations()
        ]
    ) {
        const start = declaration.getStartLineNumber();
        const end = declaration.getEndLineNumber();
        for (let line = start; line <= end; line += 1) {
            lineKinds[line] = 'import';
        }
    }
}

function markDataLiteralLines(sourceFile, lineKinds) {
    const { SyntaxKind } = readTsMorph();
    const dataKinds = [SyntaxKind.ObjectLiteralExpression, SyntaxKind.ArrayLiteralExpression];
    const behaviorKinds = new Set([
        SyntaxKind.FunctionDeclaration,
        SyntaxKind.FunctionExpression,
        SyntaxKind.ArrowFunction,
        SyntaxKind.MethodDeclaration,
        SyntaxKind.Constructor,
        SyntaxKind.GetAccessor,
        SyntaxKind.SetAccessor,
        SyntaxKind.CallExpression
    ]);
    for (const kind of dataKinds) {
        for (const literal of sourceFile.getDescendantsOfKind(kind)) {
            const start = literal.getStartLineNumber();
            const end = literal.getEndLineNumber();
            if (end - start < 2) {
                continue;
            }
            const parent = literal.getParent();
            if (parent !== undefined && dataKinds.includes(parent.getKind())) {
                continue;
            }
            if (containsBehavior(literal, behaviorKinds)) {
                continue;
            }
            for (let line = start; line <= end; line += 1) {
                if (lineKinds[line] === 'code') {
                    lineKinds[line] = 'data';
                }
            }
        }
    }
}

function containsBehavior(literal, behaviorKinds) {
    let found = false;
    literal.forEachDescendant((descendant, traversal) => {
        if (behaviorKinds.has(descendant.getKind())) {
            found = true;
            traversal.stop();
        }
    });
    return found;
}
