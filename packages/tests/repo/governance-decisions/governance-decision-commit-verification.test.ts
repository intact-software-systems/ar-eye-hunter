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
      parentOid: fixture.parentOid,
      readRepositorySnapshot: (commitOid) =>
        readGitRepositorySnapshot({ repoRoot: fixture.root, commitOid }),
    });

    expect(verified).toMatchObject({
      decisionOnly: true,
      decisionId: fixture.transition.decisionId,
      operation: 'plan.cancel',
      receiptPath: fixture.transition.receiptPath,
    });
  });

  it('rejects a non-canonical receipt even when its JSON value is otherwise valid', () => {
    const fixture = createAppliedDecisionFixture({ prettyReceipt: true });

    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: fixture.commitOid,
        parentOid: fixture.parentOid,
        readRepositorySnapshot: (commitOid) =>
          readGitRepositorySnapshot({ repoRoot: fixture.root, commitOid }),
      }),
    ).toThrow('receipt serialization must be canonical JSON plus one newline');
  });

  it('rejects undeclared and declared-but-operation-forbidden mixed changes', () => {
    const undeclared = createAppliedDecisionFixture({ extraPath: 'unrelated.txt' });
    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: undeclared.commitOid,
        parentOid: undeclared.parentOid,
        readRepositorySnapshot: (commitOid) =>
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
        parentOid: declared.parentOid,
        readRepositorySnapshot: (commitOid) =>
          readGitRepositorySnapshot({ repoRoot: declared.root, commitOid }),
      }),
    ).toThrow('receipt declares a path that plan.cancel cannot change: unrelated.txt');
  });

  it('rejects decision digest and receipt path mismatches', () => {
    const fixture = createAppliedDecisionFixture({ requestDigest: 'f'.repeat(64) });

    expect(() =>
      verifyGovernanceDecisionCommit({
        commitOid: fixture.commitOid,
        parentOid: fixture.parentOid,
        readRepositorySnapshot: (commitOid) =>
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
        parentOid: fixture.commitOid,
        readRepositorySnapshot: (commitOid) =>
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
        parentOid: modifiedCommit,
        readRepositorySnapshot: (commitOid) =>
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
        parentOid: fixture.parentOid,
        readRepositorySnapshot: (commitOid) =>
          commitOid === fixture.parentOid ? parentSnapshot : forgedCommitSnapshot,
      }),
    ).toThrow('plan.cancel must delete its target plan');
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
        parentOid: fixture.parentOid,
        readRepositorySnapshot: (commitOid) =>
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
        parentOid: fixture.parentOid,
        readRepositorySnapshot: (commitOid) =>
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
}

function createAppliedDecisionFixture(options: AppliedDecisionOptions = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'governance-commit-'));
  fixtureRoots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: root });
  mkdirSync(path.join(root, 'plans'), { recursive: true });
  const planPath = 'plans/authenticated-governance-decisions.md';
  writeFileSync(
    path.join(root, planPath),
    readFileSync(path.resolve('plans/authenticated-governance-decisions-plan.md')),
  );
  writeFileSync(path.join(root, 'plans/README.md'), '# Active adaptive plans\n\nBefore.\n');
  writeFileSync(path.join(root, 'unrelated.txt'), 'before\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'parent'], { cwd: root });
  const parentOid = readHead(root);
  const parentSnapshot = readGitRepositorySnapshot({ repoRoot: root, commitOid: parentOid });
  const planContent = readFileSync(path.join(root, planPath));
  const request = decodeGovernanceDecisionRequest({
    schemaVersion: 'governance-decision-request-v1',
    operation: 'plan.cancel',
    repository: 'intact-software-systems/ar-eye-hunter',
    defaultBranch: 'main',
    expectedHeadOid: parentOid,
    force: true,
    reason: 'Administrator cancellation is required.',
    target: { planPath, planDigest: computeSha256(planContent) },
    payload: {},
  });
  const transition = computeGovernanceDecisionTransition({ request, snapshot: parentSnapshot });
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
    transport: { kind: 'local' },
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

function readHead(root: string) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function replaceCommitEntry(snapshot: any, entryPath: string, replacement: any) {
  return {
    ...snapshot,
    entries: snapshot.entries.map((entry: any) => (entry.path === entryPath ? replacement : entry)),
  };
}
