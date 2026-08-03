import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import { MUTATION_ROUTE_INVENTORY } from '../shared-server/mutation-routing-inventory.ts';

const approvedBase = '0a52ecee39181c7784fa6b777270f8a59bc33c00';
const groupStateSourceRoot = 'apps/api-v1/src/group-state';
const commandSourcePath = `${groupStateSourceRoot}/to-group-state-command.ts`;
const registrationSourceByType = new Map<AppInboxType, string>([
  [AppInboxType.GROUP_CREATE, 'register-group-state-mutation-routes.ts'],
  [AppInboxType.GROUP_UPDATE, 'register-group-state-mutation-routes.ts'],
  [AppInboxType.GROUP_DIRECTOR_APPOINT, 'register-group-state-mutation-routes.ts'],
  [AppInboxType.GROUP_JOIN, 'register-group-admission-routes.ts'],
  [AppInboxType.GROUP_INVITE_CREATE, 'register-group-admission-routes.ts'],
  [AppInboxType.GROUP_INVITE_REVOKE, 'register-group-admission-routes.ts'],
  [AppInboxType.GROUP_INVITE_ACCEPT, 'register-group-admission-routes.ts'],
  [AppInboxType.GROUP_JOIN_CODE_ROTATE, 'register-group-admission-routes.ts'],
  [AppInboxType.GROUP_MEMBER_REMOVE, 'register-group-membership-routes.ts'],
  [AppInboxType.GROUP_MEMBER_BAN, 'register-group-membership-routes.ts'],
  [AppInboxType.GROUP_MEMBER_UNBAN, 'register-group-membership-routes.ts'],
  [AppInboxType.GROUP_MEMBER_ROLE_SET, 'register-group-membership-routes.ts'],
  [AppInboxType.GROUP_OWNERSHIP_TRANSFER, 'register-group-membership-routes.ts'],
  [AppInboxType.GROUP_MEMBER_UPSERT, 'register-group-membership-routes.ts'],
  [AppInboxType.GROUP_PRESENCE_CONNECT, 'register-group-presence-routes.ts'],
  [AppInboxType.GROUP_PRESENCE_HEARTBEAT, 'register-group-presence-routes.ts'],
  [AppInboxType.GROUP_PRESENCE_DISCONNECT, 'register-group-presence-routes.ts'],
]);
const familyRegistrars = [
  'registerGroupStateReadRoutes',
  'registerGroupStateMutationRoutes',
  'registerGroupAdmissionRoutes',
  'registerGroupMembershipRoutes',
  'registerGroupPresenceRoutes',
] as const;
const compatibilityPaths = [
  'apps/api-v1/src/routes/group-state-routes.ts',
  'apps/api-v1/src/routes/group-state-route-errors.ts',
] as const;

describe('API-v1 group-state route structure', () => {
  it('maps every HTTP mutation to one canonical registrar and command translator', () => {
    const groupHttpEntries = MUTATION_ROUTE_INVENTORY.filter(
      (entry) => entry.transport === 'HTTP' && registrationSourceByType.has(entry.type),
    );

    expect(groupHttpEntries).toHaveLength(17);
    expect(new Set(groupHttpEntries.map((entry) => entry.type))).toHaveLength(17);
    expect(new Set(groupHttpEntries.map((entry) => entry.entrypoint))).toHaveLength(17);
    for (const entry of groupHttpEntries) {
      expect(entry.sourcePath).toBe(
        `${groupStateSourceRoot}/${registrationSourceByType.get(entry.type)}`,
      );
      expect(entry.enqueueSourcePath).toBe(commandSourcePath);
      expect(entry.enqueueMarker).toBe(`AppInboxType.${entry.type}`);
    }
  });

  it('installs each cohesive route family once from the canonical registrar', () => {
    const source = read('apps/api-v1/src/group-state/register-group-state-routes.ts');

    for (const registrar of familyRegistrars) {
      expect(count(source, `import { ${registrar} }`), registrar).toBe(1);
      expect(count(source, `${registrar}(`), registrar).toBe(1);
    }
  });

  it('removes the temporary compatibility modules after canonical consumers migrate', () => {
    expect(compatibilityPaths.filter(existsSync)).toEqual([]);
  });

  it('keeps protected API, consumer, server, and middleware production unchanged', () => {
    const changedPaths = readChangedPaths();
    const protectedChanges = changedPaths.filter(isProtectedPath);

    expect(protectedChanges).toEqual([]);
  });
});

function read(relativePath: string): string {
  return readFileSync(relativePath, 'utf8');
}

function count(source: string, value: string): number {
  return source.split(value).length - 1;
}

function readChangedPaths(): readonly string[] {
  return execFileSync('git', ['diff', '--name-only', approvedBase, '--'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);
}

function isProtectedPath(filePath: string): boolean {
  return (
    filePath === 'apps/api-v1/resources/api-v1-openapi.yaml' ||
    filePath === 'apps/api-v1/src/middleware.ts' ||
    filePath === 'apps/api-v1/src/middleware-contract.ts' ||
    filePath === 'packages/shared/api/group-types.ts' ||
    filePath === 'packages/shared/api/state-types.ts' ||
    filePath === 'packages/shared-web/browser/api-integration.ts' ||
    filePath.startsWith('packages/shared-test/black-box-runner/') ||
    (filePath.startsWith('packages/shared-server/') && filePath.endsWith('.ts'))
  );
}
