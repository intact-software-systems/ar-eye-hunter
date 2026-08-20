import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const groupTopologyCapabilityBaseCommit = 'aa124e03775492f9e37882bb9ed02b03dfe0dad6';
export const groupTopologyCapabilityBaseTree = '7fdefc3d98f875298c95a65d716de88a3741c00a';
export const predecessorGroupTopologyTestRoot = 'packages/tests/shared-server/topology';
export const mirroredGroupTopologyTestRoot = 'packages/tests/shared-server/rallar-system/topology';
export const groupTopologyPlanningSnapshotPath =
  'packages/shared-server/rallar-system/topology/planning/' + 'select-group-topology-planning-snapshot.ts';
export const rtcTopologyWorkHandlerPath = 'packages/shared-server/rallar-system/topology/replay/create-rtc-topology-work-handler.ts';

export const groupTopologySourceStyleSnapshotOwner = 'rallar-group-topology-server-structure child through PR D';
export const groupTopologySourceStyleSnapshotRemovalCondition =
  'The later evidence ledger decides removal after all rows have human dispositions and ' +
  'permanent semantic and size checks own the loss risks.';

export function runGit(...arguments_: readonly string[]): string {
  return execFileSync('git', arguments_, { cwd: process.cwd(), encoding: 'utf8' }).trim();
}

export function countSourceMatches(sources: readonly string[], expression: RegExp): number {
  return sources.reduce((count, source) => count + [...source.matchAll(expression)].length, 0);
}

export function maximumSourceLineWidth(source: string): number {
  return Math.max(...source.split(/\r?\n/u).map((line) => line.length));
}

export function maximumEnforcedLineWidth(source: string): number {
  return Math.max(
    ...source
      .split(/\r?\n/u)
      .filter((line) => !isModuleSpecifierLine(line))
      .map((line) => line.length),
  );
}

function isModuleSpecifierLine(line: string): boolean {
  return (
    /^\s*(?:import|export)\b[^'"`]*from\s*['"`][^'"`]+['"`];?\s*$/u.test(line) ||
    /^\s*(?:import|export)\s*['"`][^'"`]+['"`];?\s*$/u.test(line)
  );
}

export function sourceLineCount(source: string): number {
  return source.split(/\r?\n/u).length;
}

export function readWorkspaceFile(filePath: string): string {
  return readFileSync(resolveWorkspacePath(filePath), 'utf8');
}

export function resolveWorkspacePath(filePath: string): string {
  return path.join(process.cwd(), filePath);
}
