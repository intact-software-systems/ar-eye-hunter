import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { scanProductionSources } from '../../../scripts/repo-style-check/repository-scan.mjs';
import { readBoundaryOccurrences } from './auth-server-lineage-boundary-analysis.ts';

export const authShellBase = 'a90042398448776b0972aaaaa0f5cca762163fde';
export const authShellManifestPath = 'plans/repo-style-lineages/rallar-auth-server-pr-b-shell.json';
const sourcePath = 'packages/shared-server/rallar-system/services/AppAuthInboxService.ts';
const serviceTarget = 'packages/shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
const handlerTarget = 'packages/shared-server/rallar-system/auth/inbox/auth-inbox-handler.ts';
const sourceBlob = 'a41d705cf26f9dacf38c0b7dada4a52f64f3a9fd';
const targetPaths = [serviceTarget, handlerTarget] as const;

export interface AuthShellLineage {
  readonly mergeBase: string;
  readonly source: Readonly<{ path: string; blob: string }>;
  readonly targets: readonly string[];
}

interface AuthShellSourceEvidence {
  readonly path: string;
  readonly owner: string;
  readonly span: string;
  readonly usageLine: number;
  readonly usageText: string;
  readonly ownerContentHash: string;
}

interface AuthShellTargetEvidence extends AuthShellSourceEvidence {
  readonly fileContentHash: string;
}

export interface AuthShellBoundaryEvidence {
  readonly id: string;
  readonly ruleId: string;
  readonly source: AuthShellSourceEvidence;
  readonly target: AuthShellTargetEvidence;
}

interface ValidateAuthShellLineageInput {
  readonly lineages?: readonly AuthShellLineage[];
  readonly evidence?: readonly AuthShellBoundaryEvidence[];
  readonly targetOverrides?: ReadonlyMap<string, string>;
}

interface StyleFinding {
  readonly file: string;
  readonly ruleId: string;
  readonly message: string;
}

export const authShellLineages: readonly AuthShellLineage[] = [
  {
    mergeBase: authShellBase,
    source: { path: sourcePath, blob: sourceBlob },
    targets: targetPaths,
  },
];

export const authShellBoundaryEvidence: readonly AuthShellBoundaryEvidence[] = [
  {
    id: 'registered-command-boundary',
    ruleId: 'boundary.unknown',
    source: {
      path: sourcePath,
      owner: 'AppAuthInboxService.constructor',
      span: '63-92',
      usageLine: 87,
      usageText: 'this.onStateMessage<unknown>(',
      ownerContentHash: '1f541ab50a80558ec4eca7a8b7e0f0eaa2799f1a4a73a5c42641085e5978ba3c',
    },
    target: {
      path: serviceTarget,
      owner: 'AppAuthInboxService.constructor',
      span: '78-119',
      usageLine: 113,
      usageText: 'this.onStateMessage<unknown>(',
      ownerContentHash: '8965a4f9ef1bf95d6672cf6c04415383fafb433a44c58a4c5b1a55566a206c7b',
      fileContentHash: 'c4a4d4692f2fb7bd4f22ef657c24f75764913cdaff8dac87f25bd4a13b3db117',
    },
  },
  {
    id: 'decoded-command-boundary',
    ruleId: 'boundary.unknown',
    source: {
      path: sourcePath,
      owner: 'AppAuthInboxService.processCommand',
      span: '290-313',
      usageLine: 291,
      usageText: 'input: unknown,',
      ownerContentHash: '456a32490c00eda8d6a7f256bb8b877ee3c2bff41fc207fc178b1d50d70c3a1b',
    },
    target: {
      path: handlerTarget,
      owner: 'AuthInboxHandler.processAuthMutation',
      span: '32-57',
      usageLine: 33,
      usageText: 'commandCandidate: unknown,',
      ownerContentHash: '84b0c54eb5b5dcf41ae0ce6181f2e03e6dc481012aebf9395960761f8e65e914',
      fileContentHash: '142974673186e7f84666083b63211d6452fda223ab8b48fd087c22e192be6244',
    },
  },
];

// Retain this PR B lineage evidence through PR C. The later ledger decides
// removal only after PR C's resulting-main workflow publishes equivalent
// semantic shell ownership evidence.
export function validateAuthShellLineage(input: ValidateAuthShellLineageInput = {}): void {
  const lineages = input.lineages ?? authShellLineages;
  const evidence = input.evidence ?? authShellBoundaryEvidence;
  const targetOverrides = input.targetOverrides ?? new Map<string, string>();

  validateShellLineageIdentity(lineages);
  validateEvidenceIdentity(evidence);
  validateBoundaryDerivation(evidence, targetOverrides);
  validateStyleFindingInventory(evidence, targetOverrides);
  validateTargetFileContent(evidence, targetOverrides);
}

function validateShellLineageIdentity(lineages: readonly AuthShellLineage[]): void {
  if (lineages.length !== 1 || lineages[0].mergeBase !== authShellBase) {
    throw new Error('shell base');
  }
  const lineage = lineages[0];
  if (lineage.source.path !== sourcePath) throw new Error('shell source path');
  if (lineage.source.blob !== sourceBlob || readSourceBlob() !== sourceBlob) {
    throw new Error('shell source blob');
  }
  if (lineage.targets.join() !== targetPaths.join()) throw new Error('shell target inventory');
  for (const targetPath of lineage.targets) {
    if (!existsSync(absolute(targetPath))) throw new Error('shell target inventory');
  }
}

function validateEvidenceIdentity(evidence: readonly AuthShellBoundaryEvidence[]): void {
  if (evidence.some(({ ruleId }) => ruleId !== 'boundary.unknown')) {
    throw new Error('shell inherited rule');
  }
  if (JSON.stringify(evidence) !== JSON.stringify(authShellBoundaryEvidence)) {
    throw new Error('shell evidence inventory');
  }
}

function validateBoundaryDerivation(
  evidence: readonly AuthShellBoundaryEvidence[],
  targetOverrides: ReadonlyMap<string, string>,
): void {
  validateOccurrences(
    readSource(),
    evidence.map(({ source }) => source),
    'source',
  );

  for (const targetPath of targetPaths) {
    const target = targetOverrides.get(targetPath) ?? read(targetPath);
    const expected = evidence
      .filter((entry) => entry.target.path === targetPath)
      .map(({ target: endpoint }) => endpoint);
    validateOccurrences(target, expected, 'target');
  }
}

function validateOccurrences(
  source: string,
  expected: readonly AuthShellSourceEvidence[],
  side: 'source' | 'target',
): void {
  const occurrences = readBoundaryOccurrences(source, 'shell boundary inventory');
  if (occurrences.length !== expected.length) throw new Error('shell boundary inventory');

  for (const endpoint of expected) {
    const occurrence = occurrences.find(({ usageLine }) => usageLine === endpoint.usageLine);
    if (occurrence === undefined) throw new Error('shell boundary inventory');
    if (occurrence.owner !== endpoint.owner) throw new Error(`shell ${side} owner`);
    if (occurrence.span !== endpoint.span) throw new Error(`shell ${side} span`);
    if (
      occurrence.usageText !== endpoint.usageText ||
      occurrence.ownerContentHash !== endpoint.ownerContentHash
    ) {
      throw new Error(`shell ${side} content`);
    }
  }
}

function validateStyleFindingInventory(
  evidence: readonly AuthShellBoundaryEvidence[],
  targetOverrides: ReadonlyMap<string, string>,
): void {
  const result = scanProductionSources({
    repoRoot: process.cwd(),
    sources: targetPaths.map((targetPath) => ({
      file: absolute(targetPath),
      raw: targetOverrides.get(targetPath) ?? read(targetPath),
    })),
    options: {
      layoutOnly: false,
      layoutDetails: false,
      constructionDetails: false,
      outputContracts: false,
      objectInterfaces: false,
    },
  }) as { findings: readonly StyleFinding[] };
  const actual = result.findings.map(toFindingIdentity).toSorted(compareFindingIdentity);
  const expected = evidence.map(toExpectedFindingIdentity).toSorted(compareFindingIdentity);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('shell style finding inventory');
  }
}

function validateTargetFileContent(
  evidence: readonly AuthShellBoundaryEvidence[],
  targetOverrides: ReadonlyMap<string, string>,
): void {
  for (const { target } of evidence) {
    const source = targetOverrides.get(target.path) ?? read(target.path);
    if (hash(source) !== target.fileContentHash) throw new Error('shell target file content');
  }
}

function toFindingIdentity(finding: StyleFinding) {
  return {
    path: path.relative(process.cwd(), finding.file).split(path.sep).join('/'),
    ruleId: finding.ruleId,
    message: finding.message,
  };
}

function toExpectedFindingIdentity({ ruleId, target }: AuthShellBoundaryEvidence) {
  return {
    path: target.path,
    ruleId,
    message:
      `Review unknown at line ${target.usageLine}: ${target.usageText} ` +
      'Keep it at an untrusted boundary and normalize it before domain logic.',
  };
}

function compareFindingIdentity(
  left: ReturnType<typeof toFindingIdentity>,
  right: ReturnType<typeof toFindingIdentity>,
): number {
  return `${left.path}:${left.ruleId}:${left.message}`.localeCompare(
    `${right.path}:${right.ruleId}:${right.message}`,
  );
}

function readSourceBlob(): string {
  return execFileSync('git', ['rev-parse', `${authShellBase}:${sourcePath}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
}

function readSource(): string {
  return execFileSync('git', ['show', `${authShellBase}:${sourcePath}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function read(filePath: string): string {
  return readFileSync(absolute(filePath), 'utf8');
}

function absolute(filePath: string): string {
  return path.join(process.cwd(), filePath);
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
