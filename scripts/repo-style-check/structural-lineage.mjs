import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { isProductionCodeFile } from './repository-scan.mjs';

const manifestDirectory = 'scripts/repo-style-check/lineages';
const worktreeTarget = 'WORKTREE';
const commitPattern = /^[0-9a-f]{40}$/u;
const manifestKeys = ['lineages', 'version'];
const lineageKeys = ['mergeBase', 'source', 'targets'];
const sourceKeys = ['blob', 'path'];

export class StructuralLineageValidationError extends Error {
    constructor(issues) {
        super(
            [
                'Invalid repository style structural lineage manifest:',
                ...issues.map((issue) => `- ${issue}`)
            ].join('\n')
        );
        this.name = 'StructuralLineageValidationError';
    }
}

export function readStructuralLineageMap(input) {
    const manifests = readManifestDocuments(input).map((document) => decodeManifest(document, input.repoRoot));
    const matchingLineages = manifests
        .flatMap((manifest) => manifest.lineages)
        .filter((lineage) => lineage.mergeBase === input.mergeBase);

    const issues = [
        ...manifests.flatMap((manifest) => manifest.issues),
        ...validateLineageOwnership(matchingLineages),
        ...matchingLineages.flatMap((lineage) => validateLineageTargets(lineage, input.renameByTargetPath)),
        ...matchingLineages.flatMap((lineage) => readLineageTreeIssues(input, lineage))
    ];
    if (issues.length > 0) {
        throw new StructuralLineageValidationError(issues.toSorted());
    }

    return new Map(
        matchingLineages.flatMap((lineage) => lineage.targets.map((targetPath) => [targetPath, lineage.source.path]))
    );
}

function readManifestDocuments(input) {
    if (input.targetReference !== worktreeTarget) {
        return readRevisionManifestDocuments(input);
    }
    const relativePaths = readWorktreeManifestPaths(input.repoRoot);
    return relativePaths.map((relativePath) => ({
        relativePath,
        source: readFileSync(path.join(input.repoRoot, relativePath), 'utf8')
    }));
}

function readRevisionManifestDocuments(input) {
    const treeResult = runGitResult(input.repoRoot, [
        'ls-tree',
        '-rz',
        '--name-only',
        input.targetCommit,
        '--',
        manifestDirectory
    ]);
    if (treeResult.status !== 0) {
        throw new StructuralLineageValidationError([
            `cannot read structural lineage manifest paths from target ${input.targetCommit}`
        ]);
    }
    return treeResult.stdout
        .split('\0')
        .filter((relativePath) => relativePath.endsWith('.json'))
        .toSorted()
        .map((relativePath) => ({
            relativePath,
            source: readRevisionManifestSource({
                repoRoot: input.repoRoot,
                targetCommit: input.targetCommit,
                relativePath
            })
        }));
}

function readRevisionManifestSource(input) {
    const sourceResult = runGitResult(input.repoRoot, [
        'show',
        `${input.targetCommit}:${input.relativePath}`
    ]);
    if (sourceResult.status !== 0) {
        throw new StructuralLineageValidationError([
            `${input.relativePath}: cannot read manifest from target ${input.targetCommit}`
        ]);
    }
    return sourceResult.stdout;
}

function readWorktreeManifestPaths(repoRoot) {
    const directory = path.join(repoRoot, manifestDirectory);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
        return [];
    }
    return readNestedWorktreeManifestPaths({ repoRoot, directory }).toSorted();
}

function readNestedWorktreeManifestPaths(input) {
    const relativePaths = [];
    for (const entry of readdirSync(input.directory, { withFileTypes: true })) {
        const entryPath = path.join(input.directory, entry.name);
        if (entry.isDirectory()) {
            relativePaths.push(
                ...readNestedWorktreeManifestPaths({ repoRoot: input.repoRoot, directory: entryPath })
            );
        }
        else if (entry.isFile() && entry.name.endsWith('.json')) {
            relativePaths.push(toPosixRelativePath(input.repoRoot, entryPath));
        }
    }
    return relativePaths;
}

function toPosixRelativePath(repoRoot, filePath) {
    return path.relative(repoRoot, filePath).split(path.sep).join(path.posix.sep);
}

function decodeManifest(document, repoRoot) {
    const envelope = decodeManifestEnvelope(document);
    if (envelope.value === undefined) {
        return { lineages: [], issues: envelope.issues };
    }
    const decodedLineages = envelope.value.map((value, index) =>
        decodeLineage({ value, location: `${document.relativePath}: lineages[${index}]`, repoRoot })
    );
    return {
        lineages: decodedLineages.flatMap((lineage) => (lineage.value === undefined ? [] : [lineage.value])),
        issues: [...envelope.issues, ...decodedLineages.flatMap((lineage) => lineage.issues)]
    };
}

function decodeManifestEnvelope(document) {
    let value;
    try {
        value = JSON.parse(document.source);
    }
    catch (error) {
        return toRejection(`${document.relativePath}: invalid JSON (${toErrorMessage(error)})`);
    }
    if (!isRecord(value)) {
        return toRejection(`${document.relativePath}: manifest must be an object`);
    }
    const issues = [
        ...validateExactKeys(value, manifestKeys, document.relativePath),
        ...(value.version === 1 ? [] : [`${document.relativePath}: version must equal 1`])
    ];
    if (!Array.isArray(value.lineages)) {
        return { value: undefined, issues: [...issues, `${document.relativePath}: lineages must be an array`] };
    }
    return { value: value.lineages, issues };
}

function decodeLineage({ value, location, repoRoot }) {
    if (!isRecord(value)) {
        return toRejection(`${location}: lineage must be an object`);
    }
    const keyIssues = validateExactKeys(value, lineageKeys, location);
    if (typeof value.mergeBase !== 'string' || !commitPattern.test(value.mergeBase)) {
        return {
            value: undefined,
            issues: [...keyIssues, `${location}: mergeBase must be a lowercase 40-character Git commit ID`]
        };
    }
    const source = decodeSource({ value: value.source, location, repoRoot });
    const targets = decodeTargets({ value: value.targets, location, repoRoot });
    const issues = [...keyIssues, ...source.issues, ...targets.issues];
    if (source.value === undefined || targets.value === undefined) {
        return { value: undefined, issues };
    }
    return {
        value: { mergeBase: value.mergeBase, source: source.value, targets: targets.value, location },
        issues
    };
}

function decodeSource({ value, location, repoRoot }) {
    if (!isRecord(value)) {
        return toRejection(`${location}: source must be an object`);
    }
    const sourcePath = decodeProductionPath({ value: value.path, role: 'source', location, repoRoot });
    const issues = [...validateExactKeys(value, sourceKeys, `${location}.source`), ...sourcePath.issues];
    if (typeof value.blob !== 'string' || !commitPattern.test(value.blob)) {
        return {
            value: undefined,
            issues: [...issues, `${location}: source blob must be a lowercase 40-character Git object ID`]
        };
    }
    return {
        value: sourcePath.value === undefined ? undefined : { path: sourcePath.value, blob: value.blob },
        issues
    };
}

function decodeTargets({ value, location, repoRoot }) {
    if (!Array.isArray(value) || value.length === 0) {
        return toRejection(`${location}: targets must be a non-empty array`);
    }
    const targets = value.map((targetValue) =>
        decodeProductionPath({ value: targetValue, role: 'target', location, repoRoot })
    );
    const issues = targets.flatMap((target) => target.issues);
    return { value: issues.length === 0 ? targets.map((target) => target.value) : undefined, issues };
}

function decodeProductionPath({ value, role, location, repoRoot }) {
    if (typeof value !== 'string' || !isNormalizedRelativePath(value)) {
        return toRejection(`${location}: ${role} path must be a normalized repository-relative path`);
    }
    if (!isProductionCodeFile(path.join(repoRoot, value))) {
        return toRejection(`${location}: ${role} path must name production code`);
    }
    return { value, issues: [] };
}

function validateLineageOwnership(lineages) {
    const sourceDeclarations = lineages.map((lineage) => ({
        key: lineage.source.path,
        location: lineage.location
    }));
    const targetDeclarations = lineages.flatMap((lineage) =>
        lineage.targets.map((targetPath) => ({ key: targetPath, location: lineage.location }))
    );
    return [
        ...validateSingleDeclaration(sourceDeclarations, 'source has multiple lineage entries'),
        ...validateSingleDeclaration(targetDeclarations, 'target belongs to multiple lineages')
    ];
}

function validateSingleDeclaration(declarations, message) {
    const firstLocationByKey = new Map();
    const issues = [];
    for (const declaration of declarations) {
        const firstLocation = firstLocationByKey.get(declaration.key);
        if (firstLocation === undefined) {
            firstLocationByKey.set(declaration.key, declaration.location);
        }
        else {
            issues.push(`${declaration.location}: ${message}: ${declaration.key} (first declared at ${firstLocation})`);
        }
    }
    return issues;
}

function validateLineageTargets(lineage, renameByTargetPath) {
    const issues = [];
    const seenTargets = new Set();
    for (const targetPath of lineage.targets) {
        if (targetPath === lineage.source.path) {
            issues.push(`${lineage.location}: target must differ from source path: ${targetPath}`);
        }
        if (seenTargets.has(targetPath)) {
            issues.push(`${lineage.location}: duplicate target: ${targetPath}`);
        }
        seenTargets.add(targetPath);
        if (renameByTargetPath.has(targetPath)) {
            issues.push(`${lineage.location}: target conflicts with detected Git rename: ${targetPath}`);
        }
    }
    return issues;
}

function validateExactKeys(value, expectedKeys, location) {
    const actualKeys = Object.keys(value).toSorted();
    return actualKeys.join('\0') === expectedKeys.join('\0')
        ? []
        : [`${location}: expected exactly keys ${expectedKeys.join(', ')}`];
}

function readLineageTreeIssues(input, lineage) {
    return [
        ...readSourceIssues(input, lineage),
        ...lineage.targets
            .filter((targetPath) => !readTargetExists(input, targetPath))
            .map((targetPath) => `${lineage.location}: target does not exist: ${targetPath}`)
    ];
}

function readSourceIssues(input, lineage) {
    const sourceSpec = `${input.mergeBase}:${lineage.source.path}`;
    const sourceResult = runGitResult(input.repoRoot, ['rev-parse', '--verify', sourceSpec]);
    if (sourceResult.status !== 0) {
        return [`${lineage.location}: source does not exist at merge base: ${lineage.source.path}`];
    }
    return sourceResult.stdout.trim() === lineage.source.blob
        ? []
        : [`${lineage.location}: source blob does not match: ${lineage.source.path}`];
}

function readTargetExists(input, relativePath) {
    if (input.targetReference === worktreeTarget) {
        const absolutePath = path.join(input.repoRoot, relativePath);
        return existsSync(absolutePath) && statSync(absolutePath).isFile();
    }
    return (
        runGitResult(input.repoRoot, ['cat-file', '-e', `${input.targetCommit}:${relativePath}`])
            .status === 0
    );
}

function toRejection(issue) {
    return { value: undefined, issues: [issue] };
}

function isNormalizedRelativePath(value) {
    return (
        value.length > 0 &&
        !value.includes('\\') &&
        !path.posix.isAbsolute(value) &&
        path.posix.normalize(value) === value &&
        value !== '.' &&
        !value.startsWith('../')
    );
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function runGitResult(repoRoot, args) {
    return spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function toErrorMessage(value) {
    return value instanceof Error ? value.message : String(value);
}
