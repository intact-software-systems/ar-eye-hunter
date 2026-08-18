import { parse } from '@babel/parser';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { analyzeSourceFile } from '../../helpers/source-analysis';

interface AstLocation {
  readonly start: Readonly<{ line: number }>;
  readonly end: Readonly<{ line: number }>;
}

interface AstNode {
  readonly type: string;
  readonly loc?: AstLocation | null;
  readonly [key: string]: unknown;
}

interface CallableMetric {
  readonly fileName: string;
  readonly name: string;
  readonly parameterCount: number;
  readonly physicalLines: number;
}

const ROOM_SOURCE_DIRECTORY = 'packages/shared-web/browser/rooms';
const ROOM_TEST_DIRECTORY = 'packages/tests/shared-web/rooms';
const REMOVED_PRIVATE_STATE_PASS_THROUGHS = ['isSameRoomRefOrId', 'resolveCurrentRoomId'] as const;

const EXPECTED_ROOM_SOURCE_FILES = [
  'browser-rallar-rooms.ts',
  'create-and-join-room.ts',
  'join-room.ts',
  'leave-room.ts',
  'rallar-room-contracts.ts',
  'rallar-rooms-facade.ts',
  'room-events.ts',
  'room-group-state-mutation-workflows.ts',
  'room-group-state-translation.ts',
  'room-group-state-workflows.ts',
  'room-membership-group-state-workflows.ts',
  'room-membership.ts',
  'room-presence.ts',
  'room-session.ts',
  'room-state-store.ts',
  'room-target.ts',
  'update-room.ts',
] as const;

const EXPECTED_ROOM_TEST_FILES = [
  'create-and-join-room.test.ts',
  'join-room.test.ts',
  'leave-room.test.ts',
  'rallar-room-realtime-channel.test.ts',
  'rallar-rooms-facade.test.ts',
  'room-code-standard.test.ts',
  'room-event-test-runtime.ts',
  'room-events-list-and-page.test.ts',
  'room-events-replay.test.ts',
  'room-events-subscription.test.ts',
  'room-group-state-mutation-workflows.test.ts',
  'room-group-state-request-translation.test.ts',
  'room-group-state-translation.test.ts',
  'room-group-state-workflows.test.ts',
  'room-membership-group-state-workflows.test.ts',
  'room-membership.test.ts',
  'room-presence.test.ts',
  'room-session.test.ts',
  'room-state-store-current-room.test.ts',
  'room-state-store.test.ts',
  'room-target.test.ts',
  'room-workflow-compat.test.ts',
  'room-workflow-test-runtime.ts',
  'update-room.test.ts',
] as const;

const REQUIRED_OWNING_DECLARATIONS = new Map<string, readonly string[]>([
  ['browser-rallar-rooms.ts', ['createBrowserRallarRooms']],
  [
    'create-and-join-room.ts',
    ['createAndJoinRoom', 'createAndSwitchRoom', 'createRoomSwitchPartialFailureError'],
  ],
  ['join-room.ts', ['enterRoom', 'joinRoom']],
  ['leave-room.ts', ['leaveRoom']],
  ['rallar-room-contracts.ts', ['RallarRoomState', 'RallarRoomSummary']],
  ['rallar-rooms-facade.ts', ['RallarRoomsFacade', 'createRallarRoomsFacade']],
  ['room-events.ts', ['createRoomEvents']],
  [
    'room-group-state-mutation-workflows.ts',
    [
      'archiveStateGroup',
      'deleteStateGroup',
      'updateStateGroupDetails',
      'updateStateGroupMetadata',
    ],
  ],
  [
    'room-group-state-translation.ts',
    ['toCreateGroupStateRequest', 'toRallarRoomState', 'toRallarRoomSummary'],
  ],
  [
    'room-group-state-workflows.ts',
    ['createAndJoinStateGroup', 'joinStateGroup', 'leaveStateGroup'],
  ],
  [
    'room-membership-group-state-workflows.ts',
    [
      'acceptStateGroupInvite',
      'banStateGroupMember',
      'createStateGroupInvite',
      'removeStateGroupMember',
      'setStateGroupMemberRole',
      'transferStateGroupOwnership',
      'unbanStateGroupMember',
    ],
  ],
  ['room-membership.ts', ['createRoomInvite', 'transferRoomOwnership']],
  ['room-presence.ts', ['waitForRoomPresence']],
  ['room-session.ts', ['createRoomSession']],
  ['room-state-store.ts', ['createRoomStateStore']],
  ['room-target.ts', ['assertValidRoomTarget', 'toJoinRoomTarget', 'toRoomTarget']],
  ['update-room.ts', ['archiveRoom', 'deleteRoom', 'updateRoom', 'updateRoomMetadata']],
]);

const LEGACY_POSITIONAL_SIGNATURES = new Map<string, number>([
  ['room-group-state-mutation-workflows.ts: archiveStateGroup', 6],
  ['room-group-state-mutation-workflows.ts: deleteStateGroup', 6],
  ['room-group-state-mutation-workflows.ts: updateStateGroupDetails', 6],
  ['room-group-state-mutation-workflows.ts: updateStateGroupMetadata', 6],
  ['room-group-state-workflows.ts: createAndJoinStateGroup', 8],
  ['room-group-state-workflows.ts: joinStateGroup', 7],
  ['room-group-state-workflows.ts: leaveStateGroup', 6],
  ['room-membership-group-state-workflows.ts: acceptStateGroupInvite', 6],
  ['room-membership-group-state-workflows.ts: banStateGroupMember', 7],
  ['room-membership-group-state-workflows.ts: createStateGroupInvite', 7],
  ['room-membership-group-state-workflows.ts: removeStateGroupMember', 7],
  ['room-membership-group-state-workflows.ts: setStateGroupMemberRole', 7],
  ['room-membership-group-state-workflows.ts: transferStateGroupOwnership', 6],
  ['room-membership-group-state-workflows.ts: unbanStateGroupMember', 7],
  ['browser-rallar-rooms.ts: setMemberRole', 4],
  ['rallar-rooms-facade.ts: setMemberRole', 4],
]);

const AUTHORITATIVE_IMPORT_NAMES = new Map<string, ReadonlySet<string>>([
  [
    '@shared/api/group-types.ts',
    new Set([
      'Group',
      'GroupEvent',
      'GroupEventType',
      'GroupJoinMode',
      'GroupMember',
      'GroupMemberStatus',
      'GroupPresenceAdmission',
      'GroupPresenceAdmissionSession',
      'GroupPresenceSession',
      'GroupPresenceSummary',
      'GroupRole',
      'GroupSnapshot',
      'GroupStateCausalRevision',
      'GroupStatus',
    ]),
  ],
  [
    '@shared/api/state-types.ts',
    new Set([
      'AcceptGroupInviteRequest',
      'AppointGroupDirectorRequest',
      'BanGroupMemberRequest',
      'ConnectGroupPresenceSessionRequest',
      'CreateGroupInviteRequest',
      'CreateGroupRequest',
      'DisconnectGroupPresenceSessionRequest',
      'GroupJoinCodeResponse',
      'HeartbeatGroupPresenceSessionRequest',
      'JoinGroupRequest',
      'RemoveGroupMemberRequest',
      'RevokeGroupInviteRequest',
      'RotateGroupJoinCodeRequest',
      'SetGroupMemberRoleRequest',
      'TransferGroupOwnershipRequest',
      'UnbanGroupMemberRequest',
      'UpdateGroupRequest',
      'UpsertGroupMemberRequest',
    ]),
  ],
  ['@shared/api/state-event-types.ts', new Set(['StateEventCursor', 'StateEventPage'])],
]);

describe('browser room code standard', () => {
  it('keeps the exact room source and mirrored test ownership trees', () => {
    expect(readTypeScriptFileNames(ROOM_SOURCE_DIRECTORY)).toEqual(EXPECTED_ROOM_SOURCE_FILES);
    expect(readTypeScriptFileNames(ROOM_TEST_DIRECTORY)).toEqual(EXPECTED_ROOM_TEST_FILES);
    expect(readTypeScriptFileNames('packages/tests/shared-web')).not.toContain(
      'rallar-room-realtime-channel.test.ts',
    );
    expect(readTypeScriptFileNames('packages/tests/shared-web')).not.toContain(
      'rallar-rooms-facade.test.ts',
    );
  });

  it('keeps the approved primary declarations in their owning files', () => {
    for (const [fileName, expectedNames] of REQUIRED_OWNING_DECLARATIONS) {
      const analysis = analyzeSourceFile(path.join(ROOM_SOURCE_DIRECTORY, fileName));
      const exportedDeclarations = analysis.topLevelDeclarations
        .filter((declaration) => declaration.exported)
        .map((declaration) => declaration.name)
        .sort();

      expect(exportedDeclarations, fileName).toEqual(expect.arrayContaining([...expectedNames]));
    }
  });

  it('keeps authoritative group-state imports inside the named translation boundary', () => {
    const violations = EXPECTED_ROOM_SOURCE_FILES.flatMap((fileName) => {
      if (fileName === 'room-group-state-translation.ts') {
        return [];
      }
      const analysis = analyzeSourceFile(path.join(ROOM_SOURCE_DIRECTORY, fileName));
      return analysis.imports.flatMap((sourceImport) => {
        const authoritativeNames = AUTHORITATIVE_IMPORT_NAMES.get(sourceImport.specifier);
        if (!authoritativeNames) {
          return [];
        }
        if (sourceImport.defaultImport || sourceImport.namespaceImport) {
          return [`${fileName}: opaque import from ${sourceImport.specifier}`];
        }
        return sourceImport.namedImports.flatMap((namedImport) =>
          namedImport.imported !== 'GroupRef' &&
          namedImport.imported !== 'roomRef' &&
          authoritativeNames.has(namedImport.imported)
            ? [`${fileName}: ${sourceImport.specifier}#${namedImport.imported}`]
            : [],
        );
      });
    });

    expect(violations).toEqual([]);
  });

  it('does not retain unused private state-store pass-throughs', () => {
    const violations = readTypeScriptFilePaths('packages/shared-web/browser').flatMap(
      (filePath) => {
        const identifiers = new Set(analyzeSourceFile(filePath).identifierNames);
        return REMOVED_PRIVATE_STATE_PASS_THROUGHS.flatMap((name) =>
          identifiers.has(name) ? [`${filePath}: ${name}`] : [],
        );
      },
    );

    expect(violations).toEqual([]);
  });

  it('limits new room-owned functions to three positional parameters', () => {
    const metrics = readRoomCallableMetrics();
    const actualLegacySignatures = metrics
      .filter((metric) => LEGACY_POSITIONAL_SIGNATURES.has(toCallableKey(metric)))
      .map((metric) => `${toCallableKey(metric)}(${metric.parameterCount})`)
      .sort();
    const expectedLegacySignatures = [...LEGACY_POSITIONAL_SIGNATURES]
      .map(([key, count]) => `${key}(${count})`)
      .sort();
    expect(actualLegacySignatures).toEqual(expectedLegacySignatures);

    const violations = metrics
      .filter((metric) => metric.parameterCount > 3)
      .filter((metric) => !LEGACY_POSITIONAL_SIGNATURES.has(toCallableKey(metric)))
      .map((metric) => `${metric.fileName}: ${metric.name}(${metric.parameterCount})`);

    expect(violations).toEqual([]);
  });

  it('keeps room-owned functions within the 60-line hard tier', () => {
    const violations = readRoomCallableMetrics()
      .filter((metric) => metric.physicalLines > 60)
      .map((metric) => `${metric.fileName}: ${metric.name}(${metric.physicalLines})`);

    expect(violations).toEqual([]);
  });
});

function readTypeScriptFileNames(directory: string): readonly string[] {
  return readdirSync(directory)
    .filter((fileName) => fileName.endsWith('.ts'))
    .sort();
}

function readTypeScriptFilePaths(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return readTypeScriptFilePaths(entryPath);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

function readRoomCallableMetrics(): readonly CallableMetric[] {
  return EXPECTED_ROOM_SOURCE_FILES.flatMap((fileName) => {
    const source = readFileSync(path.join(ROOM_SOURCE_DIRECTORY, fileName), 'utf8');
    const ast = parse(source, {
      sourceType: 'module',
      sourceFilename: fileName,
      plugins: ['typescript'],
    });
    const metrics: CallableMetric[] = [];
    walkAst(ast.program as unknown as AstNode, undefined, (node, parent) => {
      if (!isCallable(node)) {
        return;
      }
      metrics.push({
        fileName,
        name: readCallableName(node, parent),
        parameterCount: Array.isArray(node.params) ? node.params.length : 0,
        physicalLines: node.loc ? node.loc.end.line - node.loc.start.line + 1 : 0,
      });
    });
    return metrics;
  });
}

function toCallableKey(metric: CallableMetric): string {
  return `${metric.fileName}: ${metric.name}`;
}

function walkAst(
  node: AstNode,
  parent: AstNode | undefined,
  visit: (node: AstNode, parent: AstNode | undefined) => void,
): void {
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (['comments', 'errors', 'extra', 'loc', 'tokens'].includes(key)) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child)) {
          walkAst(child, node, visit);
        }
      }
    } else if (isAstNode(value)) {
      walkAst(value, node, visit);
    }
  }
}

function isCallable(node: AstNode): boolean {
  return [
    'ArrowFunctionExpression',
    'ClassMethod',
    'ClassPrivateMethod',
    'FunctionDeclaration',
    'FunctionExpression',
    'ObjectMethod',
  ].includes(node.type);
}

function readCallableName(node: AstNode, parent: AstNode | undefined): string {
  return (
    readIdentifier(node.id) ??
    readIdentifier(node.key) ??
    readIdentifier(parent?.id) ??
    readIdentifier(parent?.key) ??
    '<anonymous>'
  );
}

function readIdentifier(value: unknown): string | undefined {
  return isAstNode(value) && value.type === 'Identifier' && typeof value.name === 'string'
    ? value.name
    : undefined;
}

function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string';
}
