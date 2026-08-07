import path from 'node:path';

import { parse } from '@babel/parser';

interface ExportGroup {
  readonly target: string;
  readonly runtime?: readonly string[];
  readonly types?: readonly string[];
}

interface WrapperContract {
  readonly wrapper: string;
  readonly groups: readonly ExportGroup[];
}

export interface ModuleReference {
  readonly kind: 'dynamic' | 'import-equals' | 'require' | 'static';
  readonly requiresRuntimeIdentity: boolean;
  readonly specifier: string;
}

interface AstNode extends Record<string, unknown> {
  readonly type: string;
}

const contracts: readonly WrapperContract[] = [
  {
    wrapper: 'packages/shared-server/rallar-system/services/AppAuthInboxService.ts',
    groups: [
      {
        target: 'packages/shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts',
        runtime: ['AppAuthInboxService'],
      },
      {
        target: 'packages/shared-server/rallar-system/auth/inbox/auth-app-inbox-routing.ts',
        runtime: ['AUTH_STATE_APP_INBOX_TOPIC', 'toAuthAppInboxType'],
      },
    ],
  },
  {
    wrapper: 'packages/shared-server/rallar-system/services/auth-state-mutations.ts',
    groups: [
      {
        target: 'packages/shared-server/rallar-system/auth/auth-mutation-service.ts',
        runtime: ['createAuthMutationService'],
        types: ['AuthMutationService'],
      },
      {
        target: 'packages/shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts',
        types: [
          'AuthComputedSession',
          'AuthMutationCommand',
          'AuthMutationComputed',
          'AuthMutationFacts',
          'AuthMutationPublicResult',
          'AuthMutationRead',
          'AuthMutationResult',
          'AuthSessionEntries',
          'ConsumeAuthAgentTicketCommand',
          'ConsumeAuthWsTicketCommand',
          'IssueAuthAgentTicketsCommand',
          'IssueAuthSessionCommand',
          'IssueAuthWsTicketCommand',
          'LogoutAuthSessionCommand',
          'RegisterAuthUserCommand',
        ],
      },
      {
        target:
          'packages/shared-server/rallar-system/auth/mutation/decode-auth-mutation-command.ts',
        runtime: ['decodeAuthMutationCommand'],
      },
      {
        target: 'packages/shared-server/rallar-system/auth/mutation/decode-auth-mutation-result.ts',
        runtime: ['decodeAuthMutationResult'],
      },
      {
        target:
          'packages/shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts',
        runtime: ['AuthMutationRejectedError'],
      },
      {
        target:
          'packages/shared-server/rallar-system/auth/mutation/read/capture-auth-mutation-facts.ts',
        runtime: ['captureAuthMutationFacts'],
      },
    ],
  },
  {
    wrapper: 'packages/shared-server/rallar-system/services/auth-login-service.ts',
    groups: [
      {
        target: 'packages/shared-server/rallar-system/auth/login/authenticate-auth-user.ts',
        runtime: ['authenticateAuthUser'],
        types: ['AuthenticatedUserIdentity', 'LoginAuthUserOptions', 'LoginClientData'],
      },
      {
        target: 'packages/shared-server/rallar-system/auth/login/prepare-auth-user-registration.ts',
        runtime: ['prepareAuthUserRegistration'],
      },
    ],
  },
  {
    wrapper: 'packages/shared-server/rallar-system/services/auth-credential-issuer.ts',
    groups: [
      {
        target: 'packages/shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts',
        runtime: ['createHmacAuthCredentialIssuer', 'isValidAuthCredentialSecret'],
        types: ['AuthCredentialIssuer'],
      },
    ],
  },
  {
    wrapper: 'packages/shared-server/rallar-system/repositories/AuthSessionRepository.ts',
    groups: [
      {
        target: 'packages/shared-server/rallar-system/auth/persistence/auth-session-repository.ts',
        runtime: ['AuthSessionRepository'],
      },
      {
        target:
          'packages/shared-server/rallar-system/auth/persistence/auth-persistence-contracts.ts',
        runtime: [
          'decodePersistedAgentSessionTicket',
          'decodePersistedAuthSession',
          'decodePersistedWebSocketTicket',
        ],
        types: ['PersistedAgentSessionTicket', 'PersistedAuthSession', 'PersistedWebSocketTicket'],
      },
      {
        target:
          'packages/shared-server/rallar-system/auth/persistence/auth-legacy-compatibility.ts',
        runtime: [
          'AUTH_LEGACY_PLAINTEXT_COMPATIBILITY_DEADLINE_EPOCH_MS',
          'AUTH_LEGACY_PLAINTEXT_SCAN_LIMIT',
        ],
      },
      {
        target: 'packages/shared-server/rallar-system/auth/credentials/hash-auth-secret.ts',
        runtime: ['hashAuthSecret'],
      },
      {
        target: 'packages/shared-server/rallar-system/auth/persistence/auth-session-types.ts',
        types: ['IssuedAgentSessionTicket', 'IssuedAuthSession', 'IssuedWebSocketTicket'],
      },
    ],
  },
  {
    wrapper: 'packages/shared-server/rallar-system/repositories/AuthUserRepository.ts',
    groups: [
      {
        target: 'packages/shared-server/rallar-system/auth/persistence/auth-user-repository.ts',
        runtime: ['AuthUserRepository', 'normalizeUsername'],
        types: ['AuthUser', 'AuthUserStatus'],
      },
    ],
  },
];

const supportedExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export function readAuthCompatibilityExportViolations(
  readSource: (filePath: string) => string,
): readonly string[] {
  return contracts.flatMap((contract) => {
    const expected = expectedExports(contract);
    const actual = readWrapperExports(contract.wrapper, readSource(contract.wrapper));
    const violations = sameMultiset(actual, expected)
      ? []
      : [`${contract.wrapper}:exact-export-map`];
    for (const entry of expected) {
      const [kind, name, target] = splitExportEntry(entry);
      const localExports = readLocalExports(target, readSource(target));
      if (!localExports.includes(`${kind}:${name}`)) {
        violations.push(`${contract.wrapper}:${kind}:${name}:canonical-owner`);
      }
    }
    return violations;
  });
}

export function readModuleReferences(filePath: string, source: string): readonly ModuleReference[] {
  const program = parseSource(filePath, source);
  const references: ModuleReference[] = [];
  visit(program, (node) => {
    const reference = toModuleReference(node);
    if (reference) references.push(reference);
  });
  return references;
}

export function isSupportedSourcePath(filePath: string): boolean {
  return supportedExtensions.some((extension) => filePath.endsWith(extension));
}

function expectedExports(contract: WrapperContract): readonly string[] {
  return contract.groups.flatMap(({ target, runtime = [], types = [] }) => [
    ...runtime.map((name) => exportEntry('runtime', name, target)),
    ...types.map((name) => exportEntry('type', name, target)),
  ]);
}

function readWrapperExports(filePath: string, source: string): readonly string[] {
  const program = parseSource(filePath, source);
  return (program.body as readonly AstNode[]).flatMap((statement) => {
    if (statement.type !== 'ExportNamedDeclaration' || !statement.source) {
      return [`unsupported:<statement>->${filePath}`];
    }
    const sourceNode = statement.source as { readonly value?: unknown };
    const target = resolveModuleSpecifier(filePath, String(sourceNode.value));
    const statementKind = statement.exportKind === 'type' ? 'type' : 'runtime';
    return ((statement.specifiers as readonly AstNode[]) ?? []).map((specifier) => {
      if (specifier.type !== 'ExportSpecifier') return `unsupported:<specifier>->${target}`;
      const exported = nameOf(specifier.exported);
      const local = nameOf(specifier.local);
      const kind = specifier.exportKind === 'type' ? 'type' : statementKind;
      return exported === local
        ? exportEntry(kind, exported, target)
        : `${kind}:${local}->${exported}@${target}`;
    });
  });
}

function readLocalExports(filePath: string, source: string): readonly string[] {
  const body = parseSource(filePath, source).body as readonly AstNode[];
  const declarations = new Map<string, 'runtime' | 'type'>();
  for (const statement of body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? (statement.declaration as AstNode) : statement;
    for (const [name, kind] of declarationNames(declaration)) declarations.set(name, kind);
  }
  return body.flatMap((statement) => localExportsFromStatement(statement, declarations));
}

function localExportsFromStatement(
  statement: AstNode,
  declarations: ReadonlyMap<string, 'runtime' | 'type'>,
): readonly string[] {
  if (statement.type !== 'ExportNamedDeclaration' || statement.source) return [];
  if (statement.declaration) return declarationNames(statement.declaration as AstNode).map(toPair);
  return ((statement.specifiers as readonly AstNode[]) ?? []).flatMap((specifier) => {
    if (specifier.type !== 'ExportSpecifier') return [];
    const local = nameOf(specifier.local);
    const exported = nameOf(specifier.exported);
    const kind = specifier.exportKind === 'type' ? 'type' : declarations.get(local);
    return local === exported && kind ? [`${kind}:${exported}`] : [];
  });
}

function declarationNames(node: AstNode | undefined): readonly [string, 'runtime' | 'type'][] {
  if (!node) return [];
  if (node.type === 'VariableDeclaration') {
    return ((node.declarations as readonly AstNode[]) ?? []).flatMap((declaration) => {
      const name = nameOf(declaration.id);
      return name ? [[name, 'runtime'] as const] : [];
    });
  }
  const name = nameOf(node.id);
  if (!name) return [];
  const kind = ['TSInterfaceDeclaration', 'TSTypeAliasDeclaration'].includes(node.type)
    ? 'type'
    : 'runtime';
  return [[name, kind]];
}

function toModuleReference(node: AstNode): ModuleReference | undefined {
  if (node.type === 'ImportDeclaration') return staticImportReference(node);
  if (['ExportAllDeclaration', 'ExportNamedDeclaration'].includes(node.type) && node.source) {
    return staticExportReference(node);
  }
  if (node.type === 'TSImportEqualsDeclaration') return importEqualsReference(node);
  if (node.type === 'ImportExpression') {
    return literalReference('dynamic', node.source);
  }
  if (node.type !== 'CallExpression') return undefined;
  const callee = node.callee as AstNode;
  if (callee?.type === 'Import') return literalReference('dynamic', firstArgument(node));
  if (callee?.type === 'Identifier' && nameOf(callee) === 'require') {
    return literalReference('require', firstArgument(node));
  }
  return undefined;
}

function staticImportReference(node: AstNode): ModuleReference {
  const specifiers = (node.specifiers as readonly AstNode[]) ?? [];
  const runtime =
    node.importKind !== 'type' &&
    (specifiers.length === 0 || specifiers.some((specifier) => specifier.importKind !== 'type'));
  return reference('static', runtime, node.source);
}

function staticExportReference(node: AstNode): ModuleReference {
  const specifiers = (node.specifiers as readonly AstNode[]) ?? [];
  const runtime =
    node.exportKind !== 'type' &&
    (node.type === 'ExportAllDeclaration' ||
      specifiers.some((specifier) => specifier.exportKind !== 'type'));
  return reference('static', runtime, node.source);
}

function importEqualsReference(node: AstNode): ModuleReference | undefined {
  const moduleReference = node.moduleReference as AstNode;
  if (moduleReference?.type !== 'TSExternalModuleReference') return undefined;
  return reference('import-equals', true, moduleReference.expression);
}

function literalReference(
  kind: ModuleReference['kind'],
  value: unknown,
): ModuleReference | undefined {
  const literal = value as { readonly type?: unknown; readonly value?: unknown } | undefined;
  return literal?.type === 'StringLiteral'
    ? { kind, requiresRuntimeIdentity: true, specifier: String(literal.value) }
    : undefined;
}

function reference(
  kind: ModuleReference['kind'],
  requiresRuntimeIdentity: boolean,
  value: unknown,
): ModuleReference {
  const literal = value as { readonly value?: unknown };
  return { kind, requiresRuntimeIdentity, specifier: String(literal.value) };
}

function parseSource(filePath: string, source: string): AstNode {
  if (!isSupportedSourcePath(filePath))
    throw new Error(`${filePath}: unsupported source extension`);
  const plugins = [
    ...(isTypeScriptPath(filePath) ? (['typescript'] as const) : []),
    ...(filePath.endsWith('x') ? (['jsx'] as const) : []),
    'decorators-legacy' as const,
  ];
  try {
    return parse(source, { sourceType: 'unambiguous', plugins }).program as unknown as AstNode;
  } catch (error) {
    throw new SyntaxError(`${filePath}: ${String(error)}`);
  }
}

function visit(value: unknown, action: (node: AstNode) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) visit(item, action);
    return;
  }
  const node = value as AstNode;
  if (typeof node.type === 'string') action(node);
  for (const [key, child] of Object.entries(node)) {
    if (!['loc', 'start', 'end', 'extra'].includes(key)) visit(child, action);
  }
}

function firstArgument(node: AstNode): unknown {
  return ((node.arguments as readonly unknown[]) ?? [])[0];
}

function resolveModuleSpecifier(filePath: string, specifier: string): string {
  if (specifier.startsWith('@shared-server/')) {
    return path.posix.join('packages/shared-server', specifier.slice('@shared-server/'.length));
  }
  return specifier.startsWith('.')
    ? path.posix.normalize(path.posix.join(path.posix.dirname(filePath), specifier))
    : specifier;
}

function exportEntry(kind: string, name: string, target: string): string {
  return `${kind}:${name}@${target}`;
}

function splitExportEntry(entry: string): readonly [string, string, string] {
  const [kindAndName, target] = entry.split('@');
  const separator = kindAndName.indexOf(':');
  return [kindAndName.slice(0, separator), kindAndName.slice(separator + 1), target];
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function nameOf(value: unknown): string {
  const node = value as { readonly name?: unknown; readonly value?: unknown } | undefined;
  if (typeof node?.name === 'string') return node.name;
  return typeof node?.value === 'string' ? node.value : '';
}

function toPair(entry: readonly [string, 'runtime' | 'type']): string {
  return `${entry[1]}:${entry[0]}`;
}

function isTypeScriptPath(filePath: string): boolean {
  return ['.ts', '.tsx', '.mts', '.cts'].some((extension) => filePath.endsWith(extension));
}
