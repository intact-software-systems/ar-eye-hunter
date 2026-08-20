import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, expectTypeOf, it } from 'vitest';

import * as legacyWorkflows from '@shared-web/browser/api-workflows.ts';
import type {
  CreateAndJoinStateGroupOptions,
  JoinStateGroupIntent,
  StateGroupWorkflowValue,
} from '@shared-web/browser/api-workflows.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type {
  BanStateGroupMemberBody,
  CreateStateGroupInviteBody,
  RemoveStateGroupMemberBody,
  SetStateGroupMemberRoleBody,
  TransferStateGroupOwnershipBody,
  UnbanStateGroupMemberBody,
  UpdateStateGroupBody,
} from '@shared-web/browser/api/state-mutation-http-contracts.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';
import * as mutationWorkflows from '@shared-web/browser/rooms/room-group-state-mutation-workflows.ts';
import * as roomWorkflows from '@shared-web/browser/rooms/room-group-state-workflows.ts';
import * as membershipWorkflows from '@shared-web/browser/rooms/room-membership-group-state-workflows.ts';

type Policies = CommandsOrchestratorPolicies<StateGroupWorkflowValue>;

interface FocusedTypeCheckResult {
  readonly status: number | null;
  readonly version: string;
  readonly diagnostics: string;
}

type CreateAndJoinWorkflow = (
  displayName: string,
  principalId: string,
  sessionId: string,
  generationId: string,
  scope?: StateScope,
  policies?: Policies,
  requestedGroupId?: string,
  options?: CreateAndJoinStateGroupOptions,
) => Promise<GroupSnapshot>;

type JoinWorkflow = (
  groupId: string,
  principalId: string,
  sessionId: string,
  generationId: string,
  scope?: StateScope,
  policies?: Policies,
  intent?: JoinStateGroupIntent,
) => Promise<GroupSnapshot>;

type LeaveWorkflow = (
  groupId: string,
  principalId: string,
  sessionId: string,
  generationId: string,
  scope?: StateScope,
  policies?: Policies,
) => Promise<GroupSnapshot>;

type UpdateMetadataWorkflow = (
  groupId: string,
  patch: Readonly<Record<string, unknown>>,
  principalId: string,
  sessionId: string,
  scope?: StateScope,
  policies?: Policies,
) => Promise<GroupSnapshot>;

type UpdateDetailsWorkflow = (
  groupId: string,
  request: UpdateStateGroupBody,
  principalId: string,
  sessionId: string,
  scope?: StateScope,
  policies?: Policies,
) => Promise<GroupSnapshot>;

type LifecycleWorkflow = (
  groupId: string,
  request: Omit<UpdateStateGroupBody, 'status'>,
  principalId: string,
  sessionId: string,
  scope?: StateScope,
  policies?: Policies,
) => Promise<GroupSnapshot>;

type InviteWorkflow = (
  groupId: string,
  targetPrincipalId: string,
  request: CreateStateGroupInviteBody,
  principalId: string,
  sessionId: string,
  scope?: StateScope,
  policies?: Policies,
) => Promise<GroupSnapshot>;

type AcceptInviteWorkflow = JoinWorkflow extends (...args: infer _Args) => infer _Return
  ? (
      groupId: string,
      principalId: string,
      sessionId: string,
      generationId: string,
      scope?: StateScope,
      policies?: Policies,
    ) => Promise<GroupSnapshot>
  : never;

type GovernMemberWorkflow<TRequest> = (
  groupId: string,
  targetPrincipalId: string,
  request: TRequest,
  actorPrincipalId: string,
  sessionId: string,
  scope?: StateScope,
  policies?: Policies,
) => Promise<GroupSnapshot>;

type SetRoleWorkflow = (
  groupId: string,
  targetPrincipalId: string,
  request: SetStateGroupMemberRoleBody,
  actorPrincipalId: string,
  sessionId: string,
  scope?: StateScope,
  policies?: Policies,
) => Promise<GroupSnapshot>;

type TransferOwnershipWorkflow = (
  groupId: string,
  request: TransferStateGroupOwnershipBody,
  actorPrincipalId: string,
  sessionId: string,
  scope?: StateScope,
  policies?: Policies,
) => Promise<GroupSnapshot>;

describe('room workflow path compatibility', () => {
  it('type-checks old and owning signatures with TypeScript 7.0.2', () => {
    const result = runFocusedTypeCheck();

    expect(result.version).toBe('Version 7.0.2');
    expect(result.status, result.diagnostics).toBe(0);
    expect(result.diagnostics).toBe('');
  });

  it('keeps the exact public value export inventory', () => {
    const names = [
      'createAndJoinStateGroup',
      'joinStateGroup',
      'leaveStateGroup',
      'updateStateGroupMetadata',
      'updateStateGroupDetails',
      'archiveStateGroup',
      'deleteStateGroup',
      'createStateGroupInvite',
      'acceptStateGroupInvite',
      'removeStateGroupMember',
      'banStateGroupMember',
      'unbanStateGroupMember',
      'setStateGroupMemberRole',
      'transferStateGroupOwnership',
    ] as const;

    expect(names.map((name) => typeof legacyWorkflows[name])).toEqual(names.map(() => 'function'));
  });

  it('keeps every legacy positional function signature and return', () => {
    expectTypeOf(legacyWorkflows.createAndJoinStateGroup).toEqualTypeOf<CreateAndJoinWorkflow>();
    expectTypeOf(legacyWorkflows.joinStateGroup).toEqualTypeOf<JoinWorkflow>();
    expectTypeOf(legacyWorkflows.leaveStateGroup).toEqualTypeOf<LeaveWorkflow>();
    expectTypeOf(legacyWorkflows.updateStateGroupMetadata).toEqualTypeOf<UpdateMetadataWorkflow>();
    expectTypeOf(legacyWorkflows.updateStateGroupDetails).toEqualTypeOf<UpdateDetailsWorkflow>();
    expectTypeOf(legacyWorkflows.archiveStateGroup).toEqualTypeOf<LifecycleWorkflow>();
    expectTypeOf(legacyWorkflows.deleteStateGroup).toEqualTypeOf<LifecycleWorkflow>();
    expectTypeOf(legacyWorkflows.createStateGroupInvite).toEqualTypeOf<InviteWorkflow>();
    expectTypeOf(legacyWorkflows.acceptStateGroupInvite).toEqualTypeOf<AcceptInviteWorkflow>();
    expectTypeOf(legacyWorkflows.removeStateGroupMember).toEqualTypeOf<
      GovernMemberWorkflow<RemoveStateGroupMemberBody>
    >();
    expectTypeOf(legacyWorkflows.banStateGroupMember).toEqualTypeOf<
      GovernMemberWorkflow<BanStateGroupMemberBody>
    >();
    expectTypeOf(legacyWorkflows.unbanStateGroupMember).toEqualTypeOf<
      GovernMemberWorkflow<UnbanStateGroupMemberBody>
    >();
    expectTypeOf(legacyWorkflows.setStateGroupMemberRole).toEqualTypeOf<SetRoleWorkflow>();
    expectTypeOf(
      legacyWorkflows.transferStateGroupOwnership,
    ).toEqualTypeOf<TransferOwnershipWorkflow>();
  });

  it('makes every old-path export the exact owning-path function', () => {
    expect(legacyWorkflows.createAndJoinStateGroup).toBe(roomWorkflows.createAndJoinStateGroup);
    expect(legacyWorkflows.joinStateGroup).toBe(roomWorkflows.joinStateGroup);
    expect(legacyWorkflows.leaveStateGroup).toBe(roomWorkflows.leaveStateGroup);
    expect(legacyWorkflows.updateStateGroupMetadata).toBe(
      mutationWorkflows.updateStateGroupMetadata,
    );
    expect(legacyWorkflows.updateStateGroupDetails).toBe(mutationWorkflows.updateStateGroupDetails);
    expect(legacyWorkflows.archiveStateGroup).toBe(mutationWorkflows.archiveStateGroup);
    expect(legacyWorkflows.deleteStateGroup).toBe(mutationWorkflows.deleteStateGroup);
    expect(legacyWorkflows.createStateGroupInvite).toBe(membershipWorkflows.createStateGroupInvite);
    expect(legacyWorkflows.acceptStateGroupInvite).toBe(membershipWorkflows.acceptStateGroupInvite);
    expect(legacyWorkflows.removeStateGroupMember).toBe(membershipWorkflows.removeStateGroupMember);
    expect(legacyWorkflows.banStateGroupMember).toBe(membershipWorkflows.banStateGroupMember);
    expect(legacyWorkflows.unbanStateGroupMember).toBe(membershipWorkflows.unbanStateGroupMember);
    expect(legacyWorkflows.setStateGroupMemberRole).toBe(
      membershipWorkflows.setStateGroupMemberRole,
    );
    expect(legacyWorkflows.transferStateGroupOwnership).toBe(
      membershipWorkflows.transferStateGroupOwnership,
    );
  });
});

function runFocusedTypeCheck(): FocusedTypeCheckResult {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'rallar-room-workflow-types-'));
  const configPath = path.join(temporaryDirectory, 'tsconfig.json');
  const testPaths = [
    path.resolve('packages/tests/shared-web/rooms/room-workflow-compat.test.ts'),
    path.resolve('packages/tests/shared-web/rooms/room-group-state-translation.test.ts'),
  ];
  const compilerPath = path.resolve('node_modules/typescript/bin/tsc');

  writeFileSync(
    configPath,
    JSON.stringify({
      extends: path.resolve('packages/tests/tsconfig.json'),
      compilerOptions: {
        lib: ['ES2023', 'DOM'],
        noEmit: true,
        target: 'ES2023',
        typeRoots: [path.resolve('node_modules/@types'), path.resolve('node_modules')],
      },
      files: testPaths,
      include: [],
    }),
    'utf8',
  );

  try {
    const version = spawnSync(process.execPath, [compilerPath, '--version'], {
      encoding: 'utf8',
    });
    const check = spawnSync(
      process.execPath,
      [compilerPath, '--project', configPath, '--pretty', 'false'],
      { encoding: 'utf8' },
    );
    return {
      status: check.status,
      version: version.stdout.trim(),
      diagnostics: `${check.stdout}${check.stderr}`,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
