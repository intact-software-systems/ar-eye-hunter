import { validateStateWriteArtifact } from './compare-api-v1-state-write-results.mjs';
import { validateApiV1StateWriteEnvironment } from './validate-api-v1-state-write-environment.mjs';

const ARTIFACT_FIELDS = [
  'backend',
  'features',
  'generatedAt',
  'gitCommit',
  'measurement',
  'regressionReasons',
  'schemaVersion',
  'workloads',
];
const WORKLOAD_FIELDS = [
  'measuredRuns',
  'mutationMix',
  'name',
  'samples',
  'scale',
  'summary',
  'warmupRuns',
];

export function validateStateWritePoolingSource({ artifact, environmentText, position }) {
  validateArtifactFields(artifact, position);
  const artifactErrors = validateStateWriteArtifact(artifact);
  if (artifactErrors.length > 0) {
    throw new TypeError(
      `position ${position} artifact validation failed: ${artifactErrors.join('; ')}`,
    );
  }
  if (artifact.measurement.measuredRuns !== 9) {
    throw new TypeError(`position ${position} must contain exactly 9 measured runs`);
  }
  const environmentErrors = validateApiV1StateWriteEnvironment(environmentText);
  if (environmentErrors.length > 0) {
    throw new TypeError(
      `position ${position} environment validation failed: ${environmentErrors.join('; ')}`,
    );
  }
}

function validateArtifactFields(artifact, position) {
  if (!hasExactFields(artifact, ARTIFACT_FIELDS)) {
    throw new TypeError(`position ${position} artifact fields must match the governed schema`);
  }
  if (!Array.isArray(artifact.workloads)) {
    return;
  }
  for (const [index, workload] of artifact.workloads.entries()) {
    if (!hasExactFields(workload, WORKLOAD_FIELDS)) {
      throw new TypeError(
        `position ${position} workload ${index} fields must match the governed schema`,
      );
    }
  }
}

function hasExactFields(value, expectedFields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedFields].sort());
}
