import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { computeSha256 } from '../../../../scripts/governance-decisions/canonical-json.mjs';
import { verifyGovernanceDecisionCommit } from '../../../../scripts/governance-decisions/governance-decision-commit-verification.mjs';
import { createGovernanceDecisionReceipt } from '../../../../scripts/governance-decisions/governance-decision-receipt.mjs';
import { decodeGovernanceDecisionRequest } from '../../../../scripts/governance-decisions/governance-decision-request.mjs';
import { computeGovernanceDecisionTransition } from '../../../../scripts/governance-decisions/governance-decision-transition.mjs';
import { readGitRepositorySnapshot } from '../../../../scripts/governance-decisions/git-repository-snapshot.mjs';
import {
  createGovernanceDecisionFixturePlanRecord,
  toGovernanceDecisionFixturePlanMarkdown,
} from './governance-decision-fixture';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('governance decision structural commit verification', () => {
  it('accepts exactly one canonical receipt plus its declared cancellation changes', () => {
    const fixture = createAppliedDecisionFixture();

    const verified = verifyGovernanceDecisionCommit({
      commitOid: fixture.commitOid,
      readRepositorySnapshot: (commitOid: string) =>
        readGitRepositorySnapshot({ repoRoot: fixture.root, commitOid }),
    });

    expect(verified).toMatchObject({
      decisionOnly: true,
      decisionId: fixture.transition.decisionId,
      operation: 'plan.cancel',
      receiptPath: fixture.transition.receiptPath,
    });
  });

  it('accepts a supersession when an unchanged path shares the successor blob', () => {
    const fixture = createAppliedDecisionFixture({ operation: 'plan.supersede' });

    const verified = verifyGovernanceDecisionCommit({
      commitOid: fixture.commitOid,
      readRepositorySnapshot: (commitOid: string) =>
        readGitRepositorySnapshot({ repoRoot: fixture.root, commitOid }),
    });

    expect(verified).toMatchObject({
      decisionOnly: true,
      decisionId: fixture.transition.decisionId,
      operation: 'plan.supersede',
      receiptPath: fixture.transition.receiptPath,
    });
  });

  it('uses the actual single commit parent and rejects root and merge commits', () => {
    const fixture = createAppliedDecisionFixture();
    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: fixture.commitOid,
        readRepositorySnapshot: (commitOid: string) => {
          const snapshot = readGitRepositorySnapshot({ repoRoot: fixture.root, commitOid });
          return commitOid === fixture.commitOid ? { ...snapshot, parentOids: [] } : snapshot;
        },
      }),
    ).toThrow('governance decision commit must have exactly one actual parent');
    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: fixture.commitOid,
        readRepositorySnapshot: (commitOid: string) => {
          const snapshot = readGitRepositorySnapshot({ repoRoot: fixture.root, commitOid });
          return commitOid === fixture.commitOid
            ? { ...snapshot, parentOids: [fixture.parentOid, 'f'.repeat(40)] }
            : snapshot;
        },
      }),
    ).toThrow('governance decision commit must have exactly one actual parent');
  });

  it('rejects a receipt whose target digest is not the actual parent target', () => {
    const fixture = createAppliedDecisionFixture();
    const commitSnapshot = readGitRepositorySnapshot({
      repoRoot: fixture.root,
      commitOid: fixture.commitOid,
    });
    const receiptEntry = commitSnapshot.entries.find(
      (entry) => entry.path === fixture.transition.receiptPath,
    )!;
    const receipt = JSON.parse(receiptEntry.content);
    receipt.request.target.planDigest = 'f'.repeat(64);
    receipt.decisionId = computeSha256(canonical(receipt.request));
    receipt.requestDigest = receipt.decisionId;
    const forgedPath = `governance/decisions/${receipt.decisionId}.json`;
    const forgedContent = `${canonical(receipt)}\n`;
    const forgedSnapshot = {
      ...commitSnapshot,
      entries: [
        ...commitSnapshot.entries.filter((entry) => entry.path !== receiptEntry.path),
        {
          path: forgedPath,
          mode: '100644',
          blobOid: identityForContent(forgedContent).blobOid,
          content: forgedContent,
        },
      ],
    };
    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: fixture.commitOid,
        readRepositorySnapshot: (commitOid: string) =>
          commitOid === fixture.commitOid
            ? { ...forgedSnapshot, parentOids: [fixture.parentOid] }
            : readGitRepositorySnapshot({ repoRoot: fixture.root, commitOid }),
      }),
    ).toThrow('target plan digest does not match expected head');
  });

  it('rejects a quarantine receipt whose blob OID is not the actual parent target', () => {
    const fixture = createAppliedDecisionFixture({ operation: 'plan.quarantine' });
    const commitSnapshot = readGitRepositorySnapshot({
      repoRoot: fixture.root,
      commitOid: fixture.commitOid,
    });
    const receiptEntry = commitSnapshot.entries.find(
      (entry) => entry.path === fixture.transition.receiptPath,
    )!;
    const receipt = JSON.parse(receiptEntry.content);
    receipt.request.target.planBlobOid = 'f'.repeat(40);
    receipt.decisionId = computeSha256(canonical(receipt.request));
    receipt.requestDigest = receipt.decisionId;
    const forgedPath = `governance/decisions/${receipt.decisionId}.json`;
    const forgedContent = `${canonical(receipt)}\n`;
    const forgedSnapshot = {
      ...commitSnapshot,
      entries: [
        ...commitSnapshot.entries.filter((entry) => entry.path !== receiptEntry.path),
        {
          path: forgedPath,
          mode: '100644',
          blobOid: identityForContent(forgedContent).blobOid,
          content: forgedContent,
        },
      ],
    };
    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: fixture.commitOid,
        readRepositorySnapshot: (commitOid: string) =>
          commitOid === fixture.commitOid
            ? { ...forgedSnapshot, parentOids: [fixture.parentOid] }
            : readGitRepositorySnapshot({ repoRoot: fixture.root, commitOid }),
      }),
    ).toThrow('target plan blob identity does not match expected head');
  });

  it('rejects arbitrary declared successor bytes and non-regular changed files by replay', () => {
    const fixture = createAppliedDecisionFixture({ operation: 'plan.supersede' });
    const commitSnapshot = readGitRepositorySnapshot({
      repoRoot: fixture.root,
      commitOid: fixture.commitOid,
    });
    const successorEntry = commitSnapshot.entries.find(
      (entry) => entry.path === 'plans/successor.md',
    )!;
    const receiptEntry = commitSnapshot.entries.find(
      (entry) => entry.path === fixture.transition.receiptPath,
    )!;
    const arbitraryContent = 'arbitrary but declared successor\n';
    const receipt = JSON.parse(receiptEntry.content);
    receipt.stateChanges.find((change: any) => change.path === successorEntry.path).after =
      identityForContent(arbitraryContent);
    const declaredReceiptContent = `${canonical(receipt)}\n`;
    const arbitrarySuccessor = replaceCommitEntry(
      replaceCommitEntry(commitSnapshot, successorEntry.path, {
        ...successorEntry,
        content: arbitraryContent,
        blobOid: identityForContent(arbitraryContent).blobOid,
      }),
      receiptEntry.path,
      {
        ...receiptEntry,
        content: declaredReceiptContent,
        blobOid: identityForContent(declaredReceiptContent).blobOid,
      },
    );
    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: fixture.commitOid,
        readRepositorySnapshot: (commitOid: string) =>
          commitOid === fixture.commitOid
            ? { ...arbitrarySuccessor, parentOids: [fixture.parentOid] }
            : readGitRepositorySnapshot({ repoRoot: fixture.root, commitOid }),
      }),
    ).toThrow('successor path must contain the requested successor blob');

    const symlinkSuccessor = replaceCommitEntry(commitSnapshot, successorEntry.path, {
      ...successorEntry,
      mode: '120000',
    });
    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: fixture.commitOid,
        readRepositorySnapshot: (commitOid: string) =>
          commitOid === fixture.commitOid
            ? { ...symlinkSuccessor, parentOids: [fixture.parentOid] }
            : readGitRepositorySnapshot({ repoRoot: fixture.root, commitOid }),
      }),
    ).toThrow('changed governance path must be a regular 100644 file: plans/successor.md');
  });

  it('rejects a non-canonical receipt even when its JSON value is otherwise valid', () => {
    const fixture = createAppliedDecisionFixture({ prettyReceipt: true });

    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: fixture.commitOid,
        readRepositorySnapshot: (commitOid: string) =>
          readGitRepositorySnapshot({ repoRoot: fixture.root, commitOid }),
      }),
    ).toThrow('receipt serialization must be canonical JSON plus one newline');
  });

  it('rejects undeclared and declared-but-operation-forbidden mixed changes', () => {
    const undeclared = createAppliedDecisionFixture({ extraPath: 'unrelated.txt' });
    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: undeclared.commitOid,
        readRepositorySnapshot: (commitOid: string) =>
          readGitRepositorySnapshot({ repoRoot: undeclared.root, commitOid }),
      }),
    ).toThrow('commit changes do not match receipt stateChanges');

    const declared = createAppliedDecisionFixture({
      extraPath: 'unrelated.txt',
      declareExtraPath: true,
    });
    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: declared.commitOid,
        readRepositorySnapshot: (commitOid: string) =>
          readGitRepositorySnapshot({ repoRoot: declared.root, commitOid }),
      }),
    ).toThrow('commit does not equal the deterministic governance transition');
  });

  it('rejects decision digest and receipt path mismatches', () => {
    const fixture = createAppliedDecisionFixture({ requestDigest: 'f'.repeat(64) });

    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: fixture.commitOid,
        readRepositorySnapshot: (commitOid: string) =>
          readGitRepositorySnapshot({ repoRoot: fixture.root, commitOid }),
      }),
    ).toThrow('receipt requestDigest must equal the canonical request digest');
  });

  it('rejects any modification or deletion of an existing receipt', () => {
    const fixture = createAppliedDecisionFixture();
    writeFileSync(path.join(fixture.root, fixture.transition.receiptPath), '{}\n');
    execFileSync('git', ['add', '.'], { cwd: fixture.root });
    execFileSync('git', ['commit', '-q', '-m', 'modify immutable receipt'], {
      cwd: fixture.root,
    });
    const modifiedCommit = readHead(fixture.root);

    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: modifiedCommit,
        readRepositorySnapshot: (commitOid: string) =>
          readGitRepositorySnapshot({ repoRoot: fixture.root, commitOid }),
      }),
    ).toThrow('existing governance decision receipts are immutable');

    rmSync(path.join(fixture.root, fixture.transition.receiptPath));
    execFileSync('git', ['add', '-A'], { cwd: fixture.root });
    execFileSync('git', ['commit', '-q', '-m', 'delete immutable receipt'], {
      cwd: fixture.root,
    });
    const deletedCommit = readHead(fixture.root);
    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: deletedCommit,
        readRepositorySnapshot: (commitOid: string) =>
          readGitRepositorySnapshot({ repoRoot: fixture.root, commitOid }),
      }),
    ).toThrow('existing governance decision receipts are immutable');
  });

  it('rejects a cancellation receipt that omits the target plan deletion', () => {
    const fixture = createAppliedDecisionFixture();
    const parentSnapshot = readGitRepositorySnapshot({
      repoRoot: fixture.root,
      commitOid: fixture.parentOid,
    });
    const commitSnapshot = readGitRepositorySnapshot({
      repoRoot: fixture.root,
      commitOid: fixture.commitOid,
    });
    const targetPath = 'plans/authenticated-governance-decisions.md';
    const targetEntry = parentSnapshot.entries.find((entry) => entry.path === targetPath)!;
    const receiptEntry = commitSnapshot.entries.find(
      (entry) => entry.path === fixture.transition.receiptPath,
    )!;
    const receipt = JSON.parse(receiptEntry.content);
    receipt.stateChanges = receipt.stateChanges.filter((change: any) => change.path !== targetPath);
    const forgedCommitSnapshot = {
      ...commitSnapshot,
      entries: [
        ...commitSnapshot.entries.filter(
          (entry) => ![targetPath, fixture.transition.receiptPath].includes(entry.path),
        ),
        targetEntry,
        {
          ...receiptEntry,
          content: `${canonical(receipt)}\n`,
          blobOid: identityForContent(`${canonical(receipt)}\n`).blobOid,
        },
      ],
    };

    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: fixture.commitOid,
        readRepositorySnapshot: (commitOid: string) =>
          commitOid === fixture.parentOid ? parentSnapshot : forgedCommitSnapshot,
      }),
    ).toThrow('commit does not equal the deterministic governance transition');
  });

  it('rejects extra receipt keys and symbolic-link receipt entries', () => {
    const fixture = createAppliedDecisionFixture();
    const parentSnapshot = readGitRepositorySnapshot({
      repoRoot: fixture.root,
      commitOid: fixture.parentOid,
    });
    const commitSnapshot = readGitRepositorySnapshot({
      repoRoot: fixture.root,
      commitOid: fixture.commitOid,
    });
    const receiptEntry = commitSnapshot.entries.find(
      (entry) => entry.path === fixture.transition.receiptPath,
    )!;
    const extraReceipt = { ...JSON.parse(receiptEntry.content), untrusted: true };
    const extraContent = `${canonical(extraReceipt)}\n`;
    const withExtraKey = replaceCommitEntry(commitSnapshot, receiptEntry.path, {
      ...receiptEntry,
      content: extraContent,
      blobOid: identityForContent(extraContent).blobOid,
    });
    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: fixture.commitOid,
        readRepositorySnapshot: (commitOid: string) =>
          commitOid === fixture.parentOid ? parentSnapshot : withExtraKey,
      }),
    ).toThrow('receipt must contain exactly');

    const symlinkReceipt = replaceCommitEntry(commitSnapshot, receiptEntry.path, {
      ...receiptEntry,
      mode: '120000',
    });
    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: fixture.commitOid,
        readRepositorySnapshot: (commitOid: string) =>
          commitOid === fixture.parentOid ? parentSnapshot : symlinkReceipt,
      }),
    ).toThrow('new governance decision receipt must be a regular file');
  });
});

interface AppliedDecisionOptions {
  prettyReceipt?: boolean;
  extraPath?: string;
  declareExtraPath?: boolean;
  requestDigest?: string;
  operation?: 'plan.cancel' | 'plan.quarantine' | 'plan.supersede';
}

function createAppliedDecisionFixture(options: AppliedDecisionOptions = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'governance-commit-'));
  fixtureRoots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: root });
  mkdirSync(path.join(root, 'plans'), { recursive: true });
  const planPath = 'plans/authenticated-governance-decisions.md';
  const planMarkdown =
    options.operation === 'plan.quarantine'
      ? 'unreadable adaptive plan\n'
      : toGovernanceDecisionFixturePlanMarkdown();
  const successorPath = 'plans/successor.md';
  const successorRecord = createGovernanceDecisionFixturePlanRecord();
  successorRecord.planId = 'governance-decision-successor';
  const successorMarkdown = toPlanMarkdown(successorRecord);
  writeFileSync(path.join(root, planPath), planMarkdown);
  writeFileSync(path.join(root, 'plans/README.md'), '# Active adaptive plans\n\nBefore.\n');
  writeFileSync(path.join(root, 'unrelated.txt'), 'before\n');
  if (options.operation === 'plan.supersede') {
    writeFileSync(path.join(root, 'successor-copy.md'), successorMarkdown);
  }
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'parent'], { cwd: root });
  const parentOid = readHead(root);
  const parentSnapshot = readGitRepositorySnapshot({ repoRoot: root, commitOid: parentOid });
  const planContent = readFileSync(path.join(root, planPath));
  const request = decodeGovernanceDecisionRequest({
    schemaVersion: 'governance-decision-request-v1',
    operation: options.operation ?? 'plan.cancel',
    repository: 'intact-software-systems/ar-eye-hunter',
    defaultBranch: 'main',
    expectedHeadOid: parentOid,
    force: true,
    reason: 'Administrator cancellation is required.',
    target:
      options.operation === 'plan.quarantine'
        ? {
            planPath,
            planBlobOid: parentSnapshot.entries.find((entry) => entry.path === planPath)!.blobOid,
          }
        : { planPath, planDigest: computeSha256(planContent) },
    payload:
      options.operation === 'plan.supersede'
        ? {
            successorPlanPath: successorPath,
            successorPlanBlobOid: identityForContent(successorMarkdown).blobOid,
          }
        : {},
  });
  const transition = computeGovernanceDecisionTransition({
    request,
    snapshot: parentSnapshot,
    readBlob: () => successorMarkdown,
  });
  applyTransition(root, transition);
  if (options.extraPath) {
    writeFileSync(path.join(root, options.extraPath), 'after\n');
  }
  const stateChanges = options.declareExtraPath
    ? [
        ...transition.stateChanges,
        {
          path: options.extraPath!,
          before: identityForContent('before\n'),
          after: identityForContent('after\n'),
        },
      ]
    : transition.stateChanges;
  const receipt = createGovernanceDecisionReceipt({
    request,
    actor: { login: 'repository-admin', permission: 'admin' },
    transport: { kind: 'local-gh' },
    result: transition.result,
    bypassedInvariants: transition.bypassedInvariants,
    stateChanges,
  });
  if (options.requestDigest) {
    receipt.requestDigest = options.requestDigest;
  }
  mkdirSync(path.join(root, 'governance/decisions'), { recursive: true });
  writeFileSync(
    path.join(root, transition.receiptPath),
    options.prettyReceipt ? `${JSON.stringify(receipt, null, 2)}\n` : `${canonical(receipt)}\n`,
  );
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'apply governance decision'], { cwd: root });
  return { root, parentOid, commitOid: readHead(root), transition };
}

function applyTransition(root: string, transition: any) {
  for (const deletion of transition.deletions) {
    rmSync(path.join(root, deletion));
  }
  for (const addition of transition.additions) {
    mkdirSync(path.dirname(path.join(root, addition.path)), { recursive: true });
    writeFileSync(path.join(root, addition.path), addition.content);
  }
}

function identityForContent(content: string) {
  return {
    blobOid: execFileSync('git', ['hash-object', '--stdin'], {
      input: content,
      encoding: 'utf8',
    }).trim(),
    sha256: computeSha256(content),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function toPlanMarkdown(record: unknown): string {
  return `# Governance decision successor fixture\n\n\`\`\`plan-adaptation-v1\n${JSON.stringify(
    record,
    null,
    2,
  )}\n\`\`\`\n`;
}

function readHead(root: string) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function replaceCommitEntry(snapshot: any, entryPath: string, replacement: any) {
  return {
    ...snapshot,
    entries: snapshot.entries.map((entry: any) => (entry.path === entryPath ? replacement : entry)),
  };
}
