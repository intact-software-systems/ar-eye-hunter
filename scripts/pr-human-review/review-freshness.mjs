import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  computeAdaptivePlanRecordDigest,
  parseAdaptivePlanRecord,
} from '../plan-adaptation/adaptive-plan-record.mjs';

const authoredRoots = ['apps/', 'examples/', 'packages/', 'scripts/', 'tests/'];
const markdownDocumentation = /\.mdx?$/u;
const exactBuildContractPaths = new Set([
  '.github/PULL_REQUEST_TEMPLATE.md',
  'AGENTS.md',
  'CLAUDE.md',
  'apps/api-v1/README.md',
  'deno.json',
  'docker-compose.yml',
  'docs/README.md',
  'docs/environment-variables.md',
  'docs/pr-human-review-record.md',
  'docs/production-deployment.md',
  'docs/production-legacy-exceptions.md',
  'docs/rallar-ai-prompting-guide.md',
  'docs/rallar-ai-skill.md',
  'docs/rallar-api-reference.md',
  'docs/rallar-convergent-state-and-rtc-topology.md',
  'docs/rallar-crdt-guide.md',
  'docs/rallar-crdt-production-hardening-runbook.md',
  'docs/rallar-quickstart-and-recipes.md',
  'docs/rallar-rtc-rtt-reporting.md',
  'docs/rallar-troubleshooting-checklist.md',
  'docs/repo-code-style-exceptions.md',
  'docs/repo-human-style-guide.md',
  'docs/schema-compatibility-guide.md',
  'docs/test-structure-coupling-exceptions.md',
  'examples/README.md',
  'examples/rallar-ai-game-event/README.md',
  'examples/room-message-channel/README.md',
  'examples/room-realtime-channel/README.md',
  'no-js-files-outside-dist.sh',
  'tests/playwright/README.md',
  'tsconfig.json',
  'vitest.config.ts',
]);
const lockfilePattern =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|deno\.lock)$/u;

export function computeBuildAffectingTreeDigest({ repoRoot, headSha }) {
  const entries = readTreeEntries(repoRoot, headSha)
    .filter((entry) => isBuildAffectingPath(entry.path))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update('\0');
    hash.update(entry.mode);
    hash.update('\0');
    hash.update(entry.objectId);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function isBuildAffectingPath(repositoryPath) {
  return (
    isAuthoredBuildPath(repositoryPath) ||
    repositoryPath.startsWith('.github/actions/') ||
    repositoryPath.startsWith('.github/workflows/') ||
    repositoryPath.startsWith('.agents/') ||
    repositoryPath.startsWith('.codex-plugin/') ||
    repositoryPath.startsWith('plans/') ||
    exactBuildContractPaths.has(repositoryPath) ||
    /(?:^|\/)package\.json$/u.test(repositoryPath) ||
    lockfilePattern.test(repositoryPath)
  );
}

function isAuthoredBuildPath(repositoryPath) {
  if (!authoredRoots.some((root) => repositoryPath.startsWith(root))) {
    return false;
  }
  return (
    !markdownDocumentation.test(repositoryPath) ||
    (repositoryPath.startsWith('scripts/') && repositoryPath.endsWith('/README.md'))
  );
}

export function readCurrentPlanContext({ path, source }) {
  const record = parseAdaptivePlanRecord(source, path);
  const currentSlices = new Set(record.checkpoint?.nextSlices ?? []);
  return {
    path,
    status: record.status,
    digest: computeAdaptivePlanRecordDigest(record),
    goal: record.goal,
    acceptanceCriteria: record.acceptanceCriteria,
    capabilityTreeHypothesis: record.architecture?.intendedHypothesis,
    structuralDecision: record.checkpoint?.structure,
    ownerEntries: (record.capabilities ?? [])
      .filter((capability) => capability.activation?.state !== 'planned')
      .map(toOwnerEntry),
    initialOwnerEntries: (record.capabilities ?? [])
      .filter(
        (capability) =>
          capability.activation?.state !== 'planned' ||
          currentSlices.has(capability.activation?.slice),
      )
      .map(toOwnerEntry),
    firstSlices: record.checkpoint?.nextSlices,
  };
}

function readTreeEntries(repoRoot, headSha) {
  const source = execFileSync(
    'git',
    ['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', headSha],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return source
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [mode, _type, objectId] = line.slice(0, tab).split(' ');
      return { mode, objectId, path: line.slice(tab + 1) };
    });
}

function toOwnerEntry(capability) {
  const entry =
    capability.kind === 'guidance'
      ? capability.guidanceRole === 'router'
        ? capability.routingEntry
        : capability.skillEntry
      : capability.entry;
  return { owner: capability.owner, entry };
}
