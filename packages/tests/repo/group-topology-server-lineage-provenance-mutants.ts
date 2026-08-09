import {
  evidence,
  type ProvenanceEvidence,
} from './group-topology-server-lineage-provenance-fixtures.ts';

export function createDriftedEvidence(fieldPath: string): ProvenanceEvidence {
  const candidate = structuredClone(evidence) as MutableEvidence;
  mutateLeaf(candidate, fieldPath);
  return candidate as ProvenanceEvidence;
}

export function createEvidenceWithoutBoundaryRow(): ProvenanceEvidence {
  const boundary = evidence.rows.find(({ derivation }) => derivation.capacityEligible === true);
  return { ...evidence, rows: evidence.rows.filter(({ id }) => id !== boundary?.id) };
}

export function createEvidenceWithDuplicatedBoundaryRow(): ProvenanceEvidence {
  const boundary = evidence.rows.find(({ derivation }) => derivation.capacityEligible === true);
  if (!boundary) {
    throw new Error('Missing eligible boundary row fixture');
  }
  return { ...evidence, rows: [...evidence.rows, structuredClone(boundary)] };
}

export function createEvidenceWithoutResolvedBoundaryRow(): ProvenanceEvidence {
  const resolved = resolvedBoundaryRow();
  return { ...evidence, rows: evidence.rows.filter(({ id }) => id !== resolved.id) };
}

export function createEvidenceWithDuplicatedResolvedBoundaryRow(): ProvenanceEvidence {
  const resolved = resolvedBoundaryRow();
  return { ...evidence, rows: [...evidence.rows, structuredClone(resolved)] };
}

function resolvedBoundaryRow(): ProvenanceEvidence['rows'][number] {
  const resolved = evidence.rows.find(
    ({ magnitude, derivation }) =>
      magnitude.rule === 'boundary.unknown' && derivation.capacityEligible === false,
  );
  if (!resolved) {
    throw new Error('Missing resolved boundary row fixture');
  }
  return resolved;
}

function mutateLeaf(candidate: MutableEvidence, fieldPath: string): void {
  const segments = fieldPath.split('.');
  const key = segments.pop();
  let owner: unknown = candidate;
  for (const segment of segments) {
    owner = readIndexed(owner, segment);
  }
  if (!key || (!isRecord(owner) && !Array.isArray(owner))) {
    throw new Error(`Cannot mutate ${fieldPath}`);
  }
  const current = readIndexed(owner, key);
  owner[key] = typeof current === 'number' ? current + 1 : `${String(current)}-drift`;
}

function readIndexed(value: unknown, key: string): unknown {
  if (!isRecord(value) && !Array.isArray(value)) {
    return undefined;
  }
  return value[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

type MutableEvidence = { [key: string]: unknown };
