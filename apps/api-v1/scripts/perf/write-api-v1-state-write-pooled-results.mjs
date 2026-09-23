#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { poolApiV1StateWriteResults } from './pool-api-v1-state-write-results.mjs';

const ARGUMENT_NAMES = [
    'expected-approved-base-commit',
    'expected-candidate-commit',
    'approved-base-first',
    'candidate-first',
    'candidate-second',
    'approved-base-second',
    'approved-base-first-environment',
    'candidate-first-environment',
    'candidate-second-environment',
    'approved-base-second-environment',
    'approved-base-out',
    'candidate-out',
    'manifest-out'
];

export async function writeApiV1StateWritePooledResults(argumentsInput = process.argv.slice(2)) {
    const paths = readCliPaths(argumentsInput);
    await assertDistinctEvidencePaths(paths);
    const sourceTexts = await readCliSources(paths);
    const pooled = poolApiV1StateWriteResults({
        expectedApprovedBaseCommit: paths.expectedApprovedBaseCommit,
        expectedCandidateCommit: paths.expectedCandidateCommit,
        sources: sourceTexts
    });
    const approvedBaseSha256 = await writeCompactArtifact(paths.approvedBaseOut, pooled.approvedBase);
    const candidateSha256 = await writeCompactArtifact(paths.candidateOut, pooled.candidate);
    const manifest = {
        ...pooled.manifest,
        outputs: {
            approvedBase: { path: paths.approvedBaseOut, sha256: approvedBaseSha256 },
            candidate: { path: paths.candidateOut, sha256: candidateSha256 }
        }
    };
    await writeFile(paths.manifestOut, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote ${paths.approvedBaseOut}`);
    console.log(`Wrote ${paths.candidateOut}`);
    console.log(`Wrote ${paths.manifestOut}`);
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
    let first = true;
    for (const [key, value] of Object.entries(artifact)) {
        await writeChunk(handle, hash, `${first ? '' : ','}${JSON.stringify(key)}:`);
        if (key === 'workloads') {
            await writeWorkloadChunks(handle, hash, value);
        }
        else {
            await writeChunk(handle, hash, JSON.stringify(value));
        }
        first = false;
    }
    await writeChunk(handle, hash, '}\n');
}

async function writeWorkloadChunks(handle, hash, workloads) {
    await writeChunk(handle, hash, '[');
    for (const [index, workload] of workloads.entries()) {
        await writeChunk(handle, hash, `${index === 0 ? '' : ','}${JSON.stringify(workload)}`);
    }
    await writeChunk(handle, hash, ']');
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
    return {
        expectedApprovedBaseCommit: values['expected-approved-base-commit'],
        expectedCandidateCommit: values['expected-candidate-commit'],
        approvedBaseFirst: values['approved-base-first'],
        candidateFirst: values['candidate-first'],
        candidateSecond: values['candidate-second'],
        approvedBaseSecond: values['approved-base-second'],
        approvedBaseFirstEnvironment: values['approved-base-first-environment'],
        candidateFirstEnvironment: values['candidate-first-environment'],
        candidateSecondEnvironment: values['candidate-second-environment'],
        approvedBaseSecondEnvironment: values['approved-base-second-environment'],
        approvedBaseOut: values['approved-base-out'],
        candidateOut: values['candidate-out'],
        manifestOut: values['manifest-out']
    };
}

async function assertDistinctEvidencePaths(paths) {
    const evidencePaths = [
        paths.approvedBaseFirst,
        paths.candidateFirst,
        paths.candidateSecond,
        paths.approvedBaseSecond,
        paths.approvedBaseFirstEnvironment,
        paths.candidateFirstEnvironment,
        paths.candidateSecondEnvironment,
        paths.approvedBaseSecondEnvironment,
        paths.approvedBaseOut,
        paths.candidateOut,
        paths.manifestOut
    ].map((path) => resolve(path));
    const inodeIdentities = (
        await Promise.all(evidencePaths.map((path) => readInodeIdentity(path)))
    ).filter((identity) => identity !== undefined);
    if (
        new Set(evidencePaths).size !== evidencePaths.length ||
        new Set(inodeIdentities).size !== inodeIdentities.length
    ) {
        throw new TypeError('source, environment, output, and manifest paths must be distinct');
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

async function readCliSources(paths) {
    const descriptors = [
        ['approvedBaseFirst', paths.approvedBaseFirst, paths.approvedBaseFirstEnvironment],
        ['candidateFirst', paths.candidateFirst, paths.candidateFirstEnvironment],
        ['candidateSecond', paths.candidateSecond, paths.candidateSecondEnvironment],
        ['approvedBaseSecond', paths.approvedBaseSecond, paths.approvedBaseSecondEnvironment]
    ];
    const entries = await Promise.all(
        descriptors.map(async ([key, artifactPath, environmentPath]) => [
            key,
            {
                artifactText: await readFile(artifactPath, 'utf8'),
                environmentText: await readFile(environmentPath, 'utf8'),
                sourceName: artifactPath
            }
        ])
    );
    return Object.fromEntries(entries);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await writeApiV1StateWritePooledResults();
}
