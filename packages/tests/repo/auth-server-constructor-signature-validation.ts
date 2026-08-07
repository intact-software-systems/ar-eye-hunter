import { parse } from '@babel/parser';

interface AstNode extends Record<string, unknown> {
  readonly type: string;
}

const expectedParameters = readExpectedParameters();

export function findLockedAppAuthInboxConstructor(program: AstNode): AstNode | undefined {
  const classes = collectNodes(program, (node) => {
    if (!['ClassDeclaration', 'ClassExpression'].includes(node.type)) return false;
    const identifier = node.id as { readonly name?: unknown } | undefined;
    return identifier?.name === 'AppAuthInboxService';
  });
  if (classes.length !== 1) return undefined;

  const body = classes[0].body as { readonly body?: readonly AstNode[] } | undefined;
  const constructors = (body?.body ?? []).filter(isConstructor);
  if (constructors.length !== 1) return undefined;
  const parameters = constructors[0].params as readonly unknown[] | undefined;
  return stableJson(parameters) === expectedParameters ? constructors[0] : undefined;
}

export function hasLockedAppAuthInboxConstructor(source: string): boolean {
  const program = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program;
  return findLockedAppAuthInboxConstructor(program as unknown as AstNode) !== undefined;
}

function readExpectedParameters(): string {
  const parameters = [
    'public override readonly inbox: InboxQueueReader',
    'public override readonly resourceInbox: ResourceInboxRepository',
    'public override readonly resourceInboxResults: ResourceInboxResultsRepository',
    'database: PSqlSql',
    'public readonly authMutationService: AuthMutationService',
    'public readonly credentialIssuer: AuthCredentialIssuer',
    'public override readonly serviceId: string',
    'timing?: RallarTimingSink',
    'options?: AppInboxServiceOptions',
    'wakeQueue?: () => void',
  ];
  const program = parse(`class Expected { constructor(${parameters.join(', ')}) {} }`, {
    sourceType: 'module',
    plugins: ['typescript'],
  }).program;
  const classBody = program.body[0];
  if (classBody.type !== 'ClassDeclaration') throw new Error('Expected constructor fixture class');
  const constructor = classBody.body.body[0];
  if (constructor.type !== 'ClassMethod') throw new Error('Expected constructor fixture method');
  return stableJson(constructor.params);
}

function isConstructor(node: AstNode): boolean {
  return (
    ['ClassMethod', 'TSDeclareMethod'].includes(node.type) &&
    (node as { readonly kind?: unknown }).kind === 'constructor'
  );
}

function collectNodes(root: unknown, predicate: (node: AstNode) => boolean): readonly AstNode[] {
  const matches: AstNode[] = [];
  visit(root, (node) => {
    if (predicate(node)) matches.push(node);
  });
  return matches;
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

function stableJson(value: unknown): string {
  return JSON.stringify(value, (key, nested) =>
    ['loc', 'start', 'end', 'extra'].includes(key) ? undefined : nested,
  );
}
