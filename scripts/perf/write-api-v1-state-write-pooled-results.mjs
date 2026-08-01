#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
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
  'manifest-out',
];

export async function writeApiV1StateWritePooledResults(argumentsInput = process.argv.slice(2)) {
  const paths = readCliPaths(argumentsInput);
  await assertDistinctEvidencePaths(paths);
  const sourceTexts = await readCliSources(paths);
  const pooled = poolApiV1StateWriteResults({
    expectedApprovedBaseCommit: paths.expectedApprovedBaseCommit,
    expectedCandidateCommit: paths.expectedCandidateCommit,
    sources: sourceTexts,
  });
  const approvedBaseText = `${JSON.stringify(pooled.approvedBase, null, 2)}\n`;
  const candidateText = `${JSON.stringify(pooled.candidate, null, 2)}\n`;
  const manifest = {
    ...pooled.manifest,
    outputs: {
      approvedBase: { path: paths.approvedBaseOut, sha256: sha256(approvedBaseText) },
      candidate: { path: paths.candidateOut, sha256: sha256(candidateText) },
    },
  };
  await Promise.all([
    writeFile(paths.approvedBaseOut, approvedBaseText),
    writeFile(paths.candidateOut, candidateText),
    writeFile(paths.manifestOut, `${JSON.stringify(manifest, null, 2)}\n`),
  ]);
  console.log(`Wrote ${paths.approvedBaseOut}`);
  console.log(`Wrote ${paths.candidateOut}`);
  console.log(`Wrote ${paths.manifestOut}`);
}

function readCliPaths(argumentsInput) {
  const { values } = parseArgs({
    args: argumentsInput,
    options: Object.fromEntries(ARGUMENT_NAMES.map((name) => [name, { type: 'string' }])),
    strict: true,
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
    manifestOut: values['manifest-out'],
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
    paths.manifestOut,
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
  } catch (error) {
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
    ['approvedBaseSecond', paths.approvedBaseSecond, paths.approvedBaseSecondEnvironment],
  ];
  const entries = await Promise.all(
    descriptors.map(async ([key, artifactPath, environmentPath]) => [
      key,
      {
        artifactText: await readFile(artifactPath, 'utf8'),
        environmentText: await readFile(environmentPath, 'utf8'),
        sourceName: artifactPath,
      },
    ]),
  );
  return Object.fromEntries(entries);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeApiV1StateWritePooledResults();
}
