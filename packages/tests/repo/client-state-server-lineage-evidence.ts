import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  artifactRoot,
  expectedEvidence,
  mergeBase,
  prAResultingMain,
} from './client-state-server-mutation-lineage-inventory.ts';

const repoRoot = process.cwd();

export function validateEvidence(
  regions: readonly EvidenceRegion[],
  targetOverrides = new Map<string, string>(),
): void {
  if (JSON.stringify(regions.map(toEvidenceIdentity)) !== JSON.stringify(expectedEvidence)) {
    throw new Error('exact evidence inventory');
  }
  for (const region of regions) {
    if (hashRegions(readBaseSource(region.source), region.sourceRegions) !== region.sourceHash) {
      throw new Error(`source hash ${region.id}`);
    }
    const target = targetOverrides.get(region.target) ?? readPrAResultingTarget(region.target);
    if (hashRegions(target, `${region.targetStart}-${region.targetEnd}`) !== region.targetHash) {
      throw new Error(`target hash ${region.id}`);
    }
    const targetLines = target.split('\n').length - (target.endsWith('\n') ? 1 : 0);
    if (region.targetStart !== 1 || region.targetEnd !== targetLines) {
      throw new Error(`target region ${region.id}`);
    }
    if (region.findings.includes('file.length')) {
      throw new Error(`wrong finding ownership ${region.id}`);
    }
  }
}

function toEvidenceIdentity(region: EvidenceRegion) {
  return {
    id: region.id,
    source: region.source,
    sourceRegions: region.sourceRegions,
    target: region.target,
    exclusions: region.exclusions,
    findings: region.findings,
    disposition: region.disposition,
  };
}

export function readRegions(provenance = read(`${artifactRoot}-provenance.md`)): EvidenceRegion[] {
  const block = provenance.match(/## Machine evidence\n\n```text\n([\s\S]+?)\n```/)?.[1];
  if (!block) throw new Error('Missing client-state machine evidence');
  return block.split('\n').map((line) => {
    const [
      id,
      source,
      sourceRegions,
      sourceHash,
      target,
      targetStart,
      targetEnd,
      targetHash,
      exclusions,
      findings,
      disposition,
    ] = line.split('|');
    return {
      id,
      source,
      sourceRegions,
      sourceHash,
      target,
      targetStart: Number(targetStart),
      targetEnd: Number(targetEnd),
      targetHash,
      exclusions,
      findings: findings.split(';'),
      disposition,
    };
  });
}

export function readManifest(): unknown {
  return JSON.parse(read(`${artifactRoot}.json`));
}

export function readBaseBlob(filePath: string): string {
  return execFileSync('git', ['rev-parse', `${mergeBase}:${filePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

export function readBaseSource(filePath: string): string {
  return execFileSync('git', ['show', `${mergeBase}:${filePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

export function readPrAResultingTarget(filePath: string): string {
  return execFileSync('git', ['show', `${prAResultingMain}:${filePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

export function readPrAResultingBlob(filePath: string): string {
  return execFileSync('git', ['rev-parse', `${prAResultingMain}:${filePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

export function hashRegions(source: string, regions: string): string {
  const lines = source.split('\n');
  const selected = regions.split(',').map((region) => {
    const [start, end] = region.split('-').map(Number);
    if (!start || !end || start > end) throw new Error(`invalid region ${region}`);
    return lines.slice(start - 1, end).join('\n');
  });
  return createHash('sha256').update(selected.join('\n--- region ---\n')).digest('hex');
}

export function read(filePath: string): string {
  return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

export interface EvidenceRegion {
  id: string;
  source: string;
  sourceRegions: string;
  sourceHash: string;
  target: string;
  targetStart: number;
  targetEnd: number;
  targetHash: string;
  exclusions: string;
  findings: string[];
  disposition: string;
}
