import { createHash } from 'node:crypto';
import { normalize } from 'node:path';
import {
  poolApiV1StateWriteResults,
  poolApiV1StateWriteResultsForPositions,
} from './pool-api-v1-state-write-results.mjs';
export const GROUP_TOPOLOGY_CONFLICT_REASON_SCHEMA =
  'rallar.group-topology.state-write-conflict-reasons.v1';
export const GROUP_TOPOLOGY_PERFORMANCE_BASE_COMMIT = '1e5f5e55e6ff94c016bfe2cc11af92952a30e32f';
export const GROUP_TOPOLOGY_CONFLICT_REASON =
  'Precommitted conflict hypothesis: accept this resource movement only when measured candidate ' +
  'attempts and RuntimeStateWriteConflictError depth increase and the unchanged evaluator proves ' +
  'normalized cost is no worse.';

const WORKLOADS = ['uncontended', 'shared', 'hot'];
const CONFLICT_REASON_METRICS = [
  'sql.statements',
  'sql.rowsRead',
  'sql.serializedResultBytes',
  'postgres.transactionDurationMs',
];
const POSITION_BALANCED_PROTOCOL =
  'rallar.group-topology.state-write-position-balanced-abba-baab.v1';
const POSITION_DESCRIPTORS = [
  { key: 'approvedBaseFirst', role: 'approved-base' },
  { key: 'candidateFirst', role: 'candidate' },
  { key: 'candidateSecond', role: 'candidate' },
  { key: 'approvedBaseSecond', role: 'approved-base' },
  { key: 'candidateThird', role: 'candidate' },
  { key: 'approvedBaseThird', role: 'approved-base' },
  { key: 'approvedBaseFourth', role: 'approved-base' },
  { key: 'candidateFourth', role: 'candidate' },
];
const MIRRORED_DESCRIPTORS = [
  { key: 'candidateThird', position: 1, role: 'candidate' },
  { key: 'approvedBaseThird', position: 2, role: 'approved-base' },
  { key: 'approvedBaseFourth', position: 3, role: 'approved-base' },
  { key: 'candidateFourth', position: 4, role: 'candidate' },
];
const LEGACY_DESCRIPTORS = [
  { key: 'approvedBaseFirst', position: 1, role: 'approved-base' },
  { key: 'candidateFirst', position: 2, role: 'candidate' },
  { key: 'candidateSecond', position: 3, role: 'candidate' },
  { key: 'approvedBaseSecond', position: 4, role: 'approved-base' },
];
const OUTPUT_FIELDS = [
  'block1ApprovedBase',
  'block1Candidate',
  'block1Manifest',
  'block2ApprovedBase',
  'block2Candidate',
  'block2Manifest',
  'outerManifest',
];

export function poolGroupTopologyStateWritePositionBalancedResults(input) {
  validateProtocolInput(input);
  const reasons = parseGroupTopologyRegressionReasons(input.conflictReasonText, {
    commit: input.expectedCandidateCommit,
    tree: input.expectedCandidateTree,
  });
  const sources = readOuterSources(input.sources);
  validateEvidencePaths(input, sources);
  validateOuterSources(sources, reasons);
  const block1 = createBlock({
    name: 'block-1-abba',
    entryPoint: 'poolApiV1StateWriteResults',
    globalPositions: [1, 2, 3, 4],
    descriptors: LEGACY_DESCRIPTORS,
    pooled: poolApiV1StateWriteResults(toPoolingInput(input, sources.slice(0, 4))),
    outputs: input.outputs,
  });
  const block2 = createBlock({
    name: 'block-2-baab',
    entryPoint: 'poolApiV1StateWriteResultsForPositions',
    globalPositions: [5, 6, 7, 8],
    descriptors: MIRRORED_DESCRIPTORS,
    pooled: poolApiV1StateWriteResultsForPositions(
      toPoolingInput(input, sources.slice(4)),
      MIRRORED_DESCRIPTORS,
    ),
    outputs: input.outputs,
  });
  return {
    blocks: [block1, block2],
    manifest: createOuterManifest({ input, sources, blocks: [block1, block2] }),
  };
}

function validateProtocolInput(input) {
  requireExactFields(
    input,
    [
      'conflictReasonText',
      'conflictReasonPath',
      'expectedApprovedBaseCommit',
      'expectedApprovedBaseTree',
      'expectedCandidateCommit',
      'expectedCandidateTree',
      'outputs',
      'sources',
      'toolSha256',
    ],
    'position-balanced input',
  );
  assertEvidencePath(input.conflictReasonPath, 'conflict reason input path');
  for (const [name, value] of Object.entries({
    approvedBaseCommit: input.expectedApprovedBaseCommit,
    approvedBaseTree: input.expectedApprovedBaseTree,
    candidateCommit: input.expectedCandidateCommit,
    candidateTree: input.expectedCandidateTree,
  })) {
    if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
      throw new TypeError(`${name} must be a full lowercase Git SHA`);
    }
  }
  if (input.expectedApprovedBaseCommit !== GROUP_TOPOLOGY_PERFORMANCE_BASE_COMMIT) {
    throw new TypeError('approved base must equal the precommitted group-topology base');
  }
  requireExactFields(input.outputs, OUTPUT_FIELDS, 'output');
  validateNamedPaths(input.outputs, 'output');
  requireExactFields(
    input.toolSha256,
    ['childEvaluator', 'globalComparator', 'outerPooler', 'v1Pooler'],
    'tool hash',
  );
  if (Object.values(input.toolSha256).some((value) => !/^[0-9a-f]{64}$/.test(value))) {
    throw new TypeError('tool SHA-256 values must be lowercase hashes');
  }
}

function readOuterSources(sourceInput) {
  requireExactFields(
    sourceInput,
    POSITION_DESCRIPTORS.map(({ key }) => key).sort(),
    'source input',
  );
  return POSITION_DESCRIPTORS.map(({ key, role }, index) => {
    const source = sourceInput[key];
    requireExactFields(
      source,
      ['artifactText', 'environmentName', 'environmentText', 'sourceName'],
      `position ${index + 1} source`,
    );
    if (
      !source ||
      typeof source.artifactText !== 'string' ||
      typeof source.environmentText !== 'string' ||
      typeof source.sourceName !== 'string' ||
      typeof source.environmentName !== 'string'
    ) {
      throw new TypeError(`position ${index + 1} source is incomplete`);
    }
    assertEvidencePath(source.sourceName, `position ${index + 1} source path`);
    assertEvidencePath(source.environmentName, `position ${index + 1} environment path`);
    let artifact;
    try {
      artifact = JSON.parse(source.artifactText);
    } catch {
      throw new TypeError(`position ${index + 1} artifact is not valid JSON`);
    }
    return {
      ...source,
      artifact,
      artifactSha256: sha256(source.artifactText),
      environmentSha256: sha256(source.environmentText),
      globalPosition: index + 1,
      key,
      role,
    };
  });
}

function validateEvidencePaths(input, sources) {
  const paths = [
    input.conflictReasonPath,
    ...sources.flatMap(({ sourceName, environmentName }) => [sourceName, environmentName]),
    ...Object.values(input.outputs),
  ];
  if (new Set(paths).size !== paths.length) {
    throw new TypeError('source, environment, reason, output, and manifest paths must be distinct');
  }
}

function validateOuterSources(sources, reasons) {
  if (new Set(sources.map(({ artifactSha256 }) => artifactSha256)).size !== 8) {
    throw new TypeError('source artifact hashes must be unique across eight positions');
  }
  if (new Set(sources.map(({ environmentText }) => environmentText)).size !== 1) {
    throw new TypeError('normalized environment records must match byte-for-byte');
  }
  const timestamps = sources.map(({ artifact }) => Date.parse(artifact.generatedAt));
  if (timestamps.some((time, index) => index > 0 && time <= timestamps[index - 1])) {
    throw new TypeError(
      'artifact generatedAt values must increase in eight-position chronological order',
    );
  }
  for (const source of sources) {
    if (source.role === 'approved-base' && !sameJson(source.artifact.regressionReasons, [])) {
      throw new TypeError('base positions must have empty regression reasons');
    }
    if (source.role === 'candidate' && !sameJson(source.artifact.regressionReasons, reasons)) {
      throw new TypeError('candidate positions must have precommitted regression reasons');
    }
  }
  validateCrossBlockRawCommandIds(sources);
}

function validateCrossBlockRawCommandIds(sources) {
  for (const role of ['approved-base', 'candidate']) {
    const roleSources = sources.filter((source) => source.role === role);
    for (const workloadName of WORKLOADS) {
      const commandIds = roleSources.flatMap((source) =>
        source.artifact.workloads
          .find((workload) => workload.name === workloadName)
          .samples.flatMap((sample) => sample.commands.map((command) => command.commandId)),
      );
      if (new Set(commandIds).size !== commandIds.length) {
        throw new TypeError('raw command IDs must be unique across position-balanced blocks');
      }
    }
  }
}

function toPoolingInput(input, sources) {
  return {
    expectedApprovedBaseCommit: input.expectedApprovedBaseCommit,
    expectedCandidateCommit: input.expectedCandidateCommit,
    sources: Object.fromEntries(sources.map((source) => [source.key, source])),
  };
}

function createBlock({ name, entryPoint, globalPositions, descriptors, pooled, outputs }) {
  const prefix = name === 'block-1-abba' ? 'block1' : 'block2';
  const outputEvidence = {
    approvedBase: {
      path: outputs[`${prefix}ApprovedBase`],
      sha256: hashCompactArtifact(pooled.approvedBase),
    },
    candidate: {
      path: outputs[`${prefix}Candidate`],
      sha256: hashCompactArtifact(pooled.candidate),
    },
  };
  const manifest = { ...pooled.manifest, outputs: outputEvidence };
  return {
    name,
    entryPoint,
    globalPositions,
    descriptors,
    approvedBase: pooled.approvedBase,
    candidate: pooled.candidate,
    manifest,
    manifestPath: outputs[`${prefix}Manifest`],
    manifestSha256: sha256(`${JSON.stringify(manifest, null, 2)}\n`),
  };
}

function createOuterManifest({ input, sources, blocks }) {
  return {
    schemaVersion: POSITION_BALANCED_PROTOCOL,
    expectedApprovedBaseCommit: input.expectedApprovedBaseCommit,
    expectedApprovedBaseTree: input.expectedApprovedBaseTree,
    expectedCandidateCommit: input.expectedCandidateCommit,
    expectedCandidateTree: input.expectedCandidateTree,
    environmentSha256: sources[0].environmentSha256,
    positions: sources.map((source) => ({
      globalPosition: source.globalPosition,
      role: source.role,
      sourcePath: source.sourceName,
      environmentPath: source.environmentName,
      artifactSha256: source.artifactSha256,
      environmentSha256: source.environmentSha256,
      gitCommit: source.artifact.gitCommit,
      gitTree:
        source.role === 'approved-base'
          ? input.expectedApprovedBaseTree
          : input.expectedCandidateTree,
      generatedAt: source.artifact.generatedAt,
    })),
    blocks: blocks.map((block) => ({
      name: block.name,
      entryPoint: block.entryPoint,
      globalPositions: block.globalPositions,
      descriptors: block.descriptors.map((descriptor, index) => ({
        key: descriptor.key,
        localPosition: descriptor.position,
        globalPosition: block.globalPositions[index],
        role: descriptor.role,
        sourcePath: block.manifest.positions[index].sourceName,
      })),
      innerManifest: { path: block.manifestPath, sha256: block.manifestSha256 },
      outputs: block.manifest.outputs,
    })),
    toolSha256: input.toolSha256,
    conflictReasonInput: {
      path: input.conflictReasonPath,
      sha256: sha256(input.conflictReasonText),
    },
    outputPath: input.outputs.outerManifest,
  };
}

function hashCompactArtifact(artifact) {
  const hash = createHash('sha256');
  hash.update('{');
  Object.entries(artifact).forEach(([key, value], index) => {
    hash.update(`${index === 0 ? '' : ','}${JSON.stringify(key)}:`);
    if (key === 'workloads') {
      hash.update('[');
      value.forEach((workload, workloadIndex) => {
        hash.update(`${workloadIndex === 0 ? '' : ','}${JSON.stringify(workload)}`);
      });
      hash.update(']');
    } else {
      hash.update(JSON.stringify(value));
    }
  });
  hash.update('}\n');
  return hash.digest('hex');
}

function validateNamedPaths(paths, label) {
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
    throw new TypeError(`${label} paths must be an object`);
  }
  Object.values(paths).forEach((path) => assertEvidencePath(path, `${label} path`));
  if (new Set(Object.values(paths)).size !== Object.values(paths).length) {
    throw new TypeError(`${label} paths must be distinct`);
  }
}

function assertEvidencePath(path, label) {
  const normalized = typeof path === 'string' ? normalize(path).replaceAll('\\', '/') : '';
  if (normalized !== path || !normalized.startsWith('tmp/perf/') || normalized.includes('/../')) {
    throw new TypeError(`${label} must be a relative path under tmp/perf/`);
  }
}

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export function parseGroupTopologyRegressionReasons(text, candidateIdentity) {
  if (text === undefined) return [];
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new TypeError('Group-topology conflict reason input must be valid JSON');
  }
  requireExactFields(input, [
    'baseCommit',
    'candidateCommit',
    'candidateTree',
    'reasons',
    'schemaVersion',
  ]);
  if (
    input.schemaVersion !== GROUP_TOPOLOGY_CONFLICT_REASON_SCHEMA ||
    input.baseCommit !== GROUP_TOPOLOGY_PERFORMANCE_BASE_COMMIT ||
    input.candidateCommit !== candidateIdentity.commit ||
    input.candidateTree !== candidateIdentity.tree
  ) {
    throw new TypeError('Group-topology conflict reason input identity is invalid');
  }
  if (!isDenseArray(input.reasons, 12)) {
    throw new TypeError('Group-topology conflict reason input must contain exactly twelve reasons');
  }
  input.reasons.forEach((entry, index) => validateReason(entry, index));
  return input.reasons;
}

function validateReason(entry, index) {
  requireExactFields(entry, ['metric', 'reason', 'workload']);
  const workload = WORKLOADS[Math.floor(index / CONFLICT_REASON_METRICS.length)];
  const metric = CONFLICT_REASON_METRICS[index % CONFLICT_REASON_METRICS.length];
  if (
    entry.workload !== workload ||
    entry.metric !== metric ||
    entry.reason !== GROUP_TOPOLOGY_CONFLICT_REASON ||
    entry.reason.replaceAll(/\s/g, '').length < 10
  ) {
    throw new TypeError(`Group-topology conflict reason ${index + 1} is invalid`);
  }
}
function requireExactFields(value, fields, label = 'Group-topology conflict reason') {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())
  ) {
    throw new TypeError(`${label} fields are invalid`);
  }
}

const isDenseArray = (value, length) =>
  Array.isArray(value) &&
  value.length === length &&
  Array.from({ length }, (_, index) => index).every((index) => Object.hasOwn(value, index));
