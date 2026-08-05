import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const mediumScaleRequirements = [
  'npm run test:api-v1:black-box:postgres:medium-scale',
  '100 independently authenticated clients',
  'five groups',
  'two Postgres-backed API processes',
  '10 client lanes plus 5 control lanes',
] as const;
const performanceGateRequirements = [
  'npm run perf:api-v1:state-write',
  'node scripts/perf/compare-api-v1-state-write-results.mjs',
  'comparative result gate',
] as const;
const lockFreeAuthoritativeWritePaths = [
  'packages/shared-server/rallar-system/client-state/client-state-service.ts',
  'packages/shared-server/rallar-system/group-state/group-state-service.ts',
  'packages/shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts',
  'packages/shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts',
  'packages/shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts',
  'packages/shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts',
  'packages/shared-server/rallar-system/repositories/RtcRttRepository.ts',
] as const;

describe('group-state owner integrity', () => {
  it('keeps targeted authoritative repositories free of lockKey calls', () => {
    for (const filePath of lockFreeAuthoritativeWritePaths) {
      expect(readRepo(filePath), filePath).not.toContain('.lockKey(');
    }
  });

  it('routes active repo guidance through the canonical skill location', () => {
    for (const filePath of [
      'AGENTS.md',
      'docs/README.md',
      'projects/cash-chase-arena/Cash_Chase_Arena_Codex_Prompt_Pack.md',
    ]) {
      const source = readRepo(filePath);
      expect(source, filePath).toContain('.agents/skills');
      expect(source, filePath).not.toMatch(/(?<!\.agents\/)skills\/\*\*/);
    }

    expect(readRepo('AGENTS.md')).not.toContain('  - `...`');
  });

  it('routes shared-server architecture validation through repository governance', () => {
    const architecture = readRepo('packages/shared-server/architecture.md');

    expect(architecture).toContain('npm run test:repo-governance');
    expect(architecture).not.toContain('packages/tests/repo/rallar-skill-integrity.test.ts');
  });

  it('keeps authoritative group and summary phases as direct statements', () => {
    const groupService = readRepo(
      'packages/shared-server/rallar-system/group-state/group-state-service.ts',
    );
    const summaryWork = readRepo(
      'packages/shared-server/rallar-system/group-state/presence/group-presence-summary-work.ts',
    );
    const clientService = readRepo(
      'packages/shared-server/rallar-system/client-state/client-state-service.ts',
    );
    const appClientInbox = readRepo(
      'packages/shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts',
    );
    const clientInboxHandler = readRepo(
      'packages/shared-server/rallar-system/client-state/inbox/client-state-inbox-handler.ts',
    );
    const groupInboxHandler = readRepo(
      'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts',
    );

    expect(groupService).not.toContain('timeMutationPhase');
    expectAllNormalized(groupService, [
      'return await readGroupMutation(repositoryFor(runtime), prepared.command)',
      'compute: (prepared, read) => computeGroupMutation',
      'validateGroupMutation({\n                command: prepared.command,',
      'await writeGroupMutation(transaction, computed)',
    ]);
    expectAll(summaryWork, [
      'async read(work: GroupPresenceSummaryWorkData)',
      'const summary = computeGroupPresenceSummary',
      'validateGroupPresenceSummary({',
      'async write(',
      'transaction: PSqlTransactionSql',
    ]);
    expectAllNormalized(groupInboxHandler, [
      'const read = await this.dependencies.mutationService.read(command)',
      'const computed = this.dependencies.mutationService.compute(command, read)',
      'this.dependencies.mutationService.validate(command, read, computed)',
      'await this.dependencies.transactionWriter.writeMutationWithAfterCommitResult(',
      'await this.dependencies.snapshotObserver.observeSnapshot(committedSnapshot)',
    ]);
    expect(clientService).not.toContain('timeMutationPhase');
    expect(clientService).not.toContain('runtime.begin(');
    expectAll(clientService, [
      'read: async (command)',
      'compute: (command, read)',
      'validate: (command, read, computed)',
      'write: async (transaction, computed)',
      'await writeClientMutation(',
    ]);
    expectAll(appClientInbox, [
      'this.registerClientStateMessages()',
      'this.handler.processCommand(',
      'this.handler.processAuthorisedWsConnect(',
    ]);
    expectAll(clientInboxHandler, [
      'this.dependencies.mutationService.read(command)',
      'this.dependencies.mutationService.compute(command, read)',
      'this.dependencies.mutationService.validate(command, read, computed)',
      'this.dependencies.transactionWriter.writeMutationWithAfterCommitResult(',
    ]);
  });

  it('routes group presence lifecycle work through canonical pure functions', () => {
    const presenceService = readRepo(
      'packages/shared-server/rallar-system/group-state/presence/group-presence-service.ts',
    );
    const groupInbox = readRepo(
      'packages/shared-server/rallar-system/services/AppGroupInboxService.ts',
    );
    const groupInboxHandler = readRepo(
      'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts',
    );
    const compatibility = readRepo(
      'packages/shared-server/rallar-system/services/app-group-ws-session-lifecycle.ts',
    );

    expect(presenceService).not.toContain('class GroupPresenceService');
    expect(presenceService).not.toContain('GroupPresenceService.');
    expect(presenceService).toContain('export function toGroupSessionCleanupEnqueue(');
    expect(presenceService).toContain('export async function processGroupPresenceConnect');
    expect(presenceService).toContain('export async function processGroupSessionCleanup');
    expect(groupInbox).toContain('processGroupSessionCleanup({');
    expect(groupInboxHandler).toContain('processGroupPresenceConnect({');
    expect(compatibility).not.toContain('class GroupPresenceService');
    expect(compatibility).toContain("from '../topology/inbox/topology-app-inbox-handler.ts';");
  });

  it('marks superseded retry designs as historical evidence, not current precedent', () => {
    for (const filePath of [
      'docs/superpowers/specs/2026-07-21-guarded-runtime-state-batch-design.md',
      'docs/superpowers/specs/2026-07-21-in-process-cas-contention-suppression-design.md',
    ]) {
      const design = readRepo(filePath);
      expectAll(design, [
        'SUPERSEDED FOR API-V1 MUTATION OWNERSHIP',
        '2026-07-22-api-v1-app-inbox-transactional-mutations-design.md',
        'historical evidence',
      ]);
    }
  });

  it.each([
    '.agents/skills/rallar-testing/SKILL.md',
    '.agents/skills/rallar-testing/references/test-commands.md',
  ])('%s independently preserves the complete medium-scale gate', (filePath) => {
    const section = readMarkdownSection(
      readRepo(filePath),
      filePath.endsWith('/SKILL.md') ? '## Selection Rules' : '## Convergent State-Write Gates',
    );
    expectAllNormalized(section, mediumScaleRequirements);
    const normalizedSection = normalizeWhitespace(section);
    expect(normalizedSection).toMatch(
      /(?:after focused tests|focused tests first(?:,| and) then)/i,
    );
    expect(normalizedSection).toMatch(
      /never reduce these constants, the operation matrix, or (?:its|the) assertions/i,
    );
  });

  it.each([
    '.agents/skills/rallar-testing/SKILL.md',
    '.agents/skills/performance-analysis/SKILL.md',
  ])('%s independently requires the governed performance comparison', (filePath) => {
    const guidance = readRepo(filePath);
    expectAllNormalized(guidance, performanceGateRequirements);
    expect(guidance).toMatch(/mutation path|mutation-path/i);
    expect(guidance).toMatch(/concurrency domain|concurrency-domain/i);
  });

  it('does not let one active testing guide borrow its gate from another file', () => {
    const testing = readRepo('.agents/skills/rallar-testing/SKILL.md').replace(
      'npm run test:api-v1:black-box:postgres:medium-scale',
      'removed-medium-scale-command',
    );
    expect(() => expectAllNormalized(testing, mediumScaleRequirements)).toThrow();
  });
});

function readMarkdownSection(source: string, heading: string): string {
  const start = source.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const nextHeading = source.indexOf('\n## ', start + heading.length);
  return source.slice(start, nextHeading < 0 ? source.length : nextHeading);
}

function readRepo(filePath: string): string {
  return readAbsolute(path.join(repoRoot, filePath));
}

function readAbsolute(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

function readJson(filePath: string): unknown {
  return JSON.parse(readRepo(filePath));
}

function expectAll(haystack: string, needles: readonly string[]): void {
  for (const needle of needles) {
    expect(haystack, needle).toContain(needle);
  }
}

function expectAllNormalized(haystack: string, needles: readonly string[]): void {
  const normalized = normalizeWhitespace(haystack);
  for (const needle of needles) {
    expect(normalized, needle).toContain(normalizeWhitespace(needle));
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
