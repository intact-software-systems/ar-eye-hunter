#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as topologyPool from './pool-group-topology-state-write-position-balanced-results.mjs';

const SOURCE_NAMES = [
    'approved-base-first',
    'candidate-first',
    'candidate-second',
    'approved-base-second',
    'candidate-third',
    'approved-base-third',
    'approved-base-fourth',
    'candidate-fourth'
];
const OUTPUT_NAMES = [
    'block1-approved-base',
    'block1-candidate',
    'block1-manifest',
    'block2-approved-base',
    'block2-candidate',
    'block2-manifest',
    'outer-manifest'
];
const IDENTITY_NAMES = [
    'expected-approved-base-commit',
    'expected-approved-base-tree',
    'expected-candidate-commit',
    'expected-candidate-tree',
    'conflict-reasons-file'
];
const TOOL_NAMES = [
    'outer-pooler-sha256',
    'v1-pooler-sha256',
    'global-comparator-sha256',
    'child-evaluator-sha256'
];
const ARGUMENT_NAMES = [
    ...IDENTITY_NAMES,
    ...SOURCE_NAMES,
    ...SOURCE_NAMES.map((name) => `${name}-environment`),
    ...OUTPUT_NAMES,
    ...TOOL_NAMES
];

export async function writeGroupTopologyStateWritePositionBalancedResults(
    argumentsInput = process.argv.slice(2)
) {
    const paths = readCliPaths(argumentsInput);
    await assertDistinctEvidencePaths(paths);
    const input = await readPoolingInput(paths);
    const pooled = topologyPool.poolGroupTopologyStateWritePositionBalancedResults(input);
    for (const block of pooled.blocks) {
        await writeAndVerifyArtifact(
            block.manifest.outputs.approvedBase.path,
            block.approvedBase,
            block.manifest.outputs.approvedBase.sha256
        );
        await writeAndVerifyArtifact(
            block.manifest.outputs.candidate.path,
            block.candidate,
            block.manifest.outputs.candidate.sha256
        );
        await writeFile(block.manifestPath, `${JSON.stringify(block.manifest, null, 2)}\n`);
    }
    await writeFile(paths.outerManifest, `${JSON.stringify(pooled.manifest, null, 2)}\n`);
    console.log(`Wrote ${paths.outerManifest}`);
}

function readCliPaths(argumentsInput) {
    const { values } = parseArgs({
        args: argumentsInput,
        options: Object.fromEntries(ARGUMENT_NAMES.map((name) => [name, { type: 'string' }])),
        strict: true
    });
    for (const name of ARGUMENT_NAMES) {
        if (typeof values[name] !== 'string' || values[name].length === 0) {
            throw new TypeError(`--${name} is required`);
        }
    }
    return Object.fromEntries(ARGUMENT_NAMES.map((name) => [toCamelCase(name), values[name]]));
}

async function readPoolingInput(paths) {
    const sources = Object.fromEntries(
        await Promise.all(
            SOURCE_NAMES.map(async (name) => {
                const key = toCamelCase(name);
                const artifactPath = paths[key];
                const environmentPath = paths[`${key}Environment`];
                return [
                    key,
                    {
                        artifactText: await readFile(artifactPath, 'utf8'),
                        environmentText: await readFile(environmentPath, 'utf8'),
                        sourceName: artifactPath,
                        environmentName: environmentPath
                    }
                ];
            })
        )
    );
    return {
        expectedApprovedBaseCommit: paths.expectedApprovedBaseCommit,
        expectedApprovedBaseTree: paths.expectedApprovedBaseTree,
        expectedCandidateCommit: paths.expectedCandidateCommit,
        expectedCandidateTree: paths.expectedCandidateTree,
        conflictReasonPath: paths.conflictReasonsFile,
        conflictReasonText: await readFile(paths.conflictReasonsFile, 'utf8'),
        sources,
        outputs: Object.fromEntries(
            OUTPUT_NAMES.map((name) => [toCamelCase(name), paths[toCamelCase(name)]])
        ),
        toolSha256: Object.fromEntries(
            TOOL_NAMES.map((name) => [
                toCamelCase(name.replace('-sha256', '')),
                paths[toCamelCase(name)]
            ])
        )
    };
}

async function assertDistinctEvidencePaths(paths) {
    const pathNames = [
        'conflictReasonsFile',
        ...SOURCE_NAMES.flatMap((name) => [toCamelCase(name), `${toCamelCase(name)}Environment`]),
        ...OUTPUT_NAMES.map(toCamelCase)
    ];
    const evidencePaths = await Promise.all(
        pathNames.map((name) => canonicalEvidencePath(paths[name]))
    );
    const inodeIdentities = (await Promise.all(evidencePaths.map(readInodeIdentity))).filter(
        (identity) => identity !== undefined
    );
    if (
        new Set(evidencePaths).size !== evidencePaths.length ||
        new Set(inodeIdentities).size !== inodeIdentities.length
    ) {
        throw new TypeError('source, environment, reason, output, and manifest paths must be distinct');
    }
}

async function canonicalEvidencePath(path) {
    const absolutePath = resolve(path);
    try {
        return await realpath(absolutePath);
    }
    catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
        return join(await realpath(dirname(absolutePath)), basename(absolutePath));
    }
}

async function readInodeIdentity(path) {
    try {
        const file = await stat(path);
        return `${file.dev}:${file.ino}`;
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

async function writeAndVerifyArtifact(path, artifact, expectedSha256) {
    const actualSha256 = await writeCompactArtifact(path, artifact);
    if (actualSha256 !== expectedSha256) {
        throw new Error(`pooled artifact hash mismatch for ${path}`);
    }
}

async function writeCompactArtifact(path, artifact) {
    const temporaryPath = `${path}.partial-${randomUUID()}`;
    const handle = await open(temporaryPath, 'wx');
    const hash = createHash('sha256');
    try {
        await writeArtifactChunks(handle, hash, artifact);
        await handle.close();
        await rename(temporaryPath, path);
        return hash.digest('hex');
    }
    catch (error) {
        await handle.close().catch(() => undefined);
        await rm(temporaryPath, { force: true });
        throw error;
    }
}

async function writeArtifactChunks(handle, hash, artifact) {
    await writeChunk(handle, hash, '{');
    for (const [index, [key, value]] of Object.entries(artifact).entries()) {
        await writeChunk(handle, hash, `${index === 0 ? '' : ','}${JSON.stringify(key)}:`);
        if (key === 'workloads') {
            await writeChunk(handle, hash, '[');
            for (const [workloadIndex, workload] of value.entries()) {
                await writeChunk(
                    handle,
                    hash,
                    `${workloadIndex === 0 ? '' : ','}${JSON.stringify(workload)}`
                );
            }
            await writeChunk(handle, hash, ']');
        }
        else {
            await writeChunk(handle, hash, JSON.stringify(value));
        }
    }
    await writeChunk(handle, hash, '}\n');
}

async function writeChunk(handle, hash, chunk) {
    const bytes = Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
        if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
            throw new Error('pooled artifact write did not make forward progress');
        }
        offset += bytesWritten;
    }
    hash.update(bytes);
}

const toCamelCase = (name) => name.replaceAll(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase());

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await writeGroupTopologyStateWritePositionBalancedResults();
}
