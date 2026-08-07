import { parse } from '@babel/parser';

export interface ModuleReference {
  readonly kind: 'dynamic' | 'import-equals' | 'require' | 'static';
  readonly requiresRuntimeIdentity: boolean;
  readonly specifier: string;
}

export interface NonliteralModuleReference {
  readonly expression: string;
  readonly kind: 'dynamic' | 'require';
}

export interface ModuleReferenceEvidence {
  readonly nonliteral: readonly NonliteralModuleReference[];
  readonly references: readonly ModuleReference[];
}

interface AstNode extends Record<string, unknown> {
  readonly end?: number;
  readonly start?: number;
  readonly type: string;
}

const supportedExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export function readModuleReferences(filePath: string, source: string): readonly ModuleReference[] {
  const evidence = readModuleReferenceEvidence(filePath, source);
  const firstNonliteral = evidence.nonliteral[0];
  if (firstNonliteral) {
    throw new SyntaxError(
      `${filePath}: nonliteral ${firstNonliteral.kind} module reference: ` +
        firstNonliteral.expression,
    );
  }
  return evidence.references;
}

export function readModuleReferenceEvidence(
  filePath: string,
  source: string,
): ModuleReferenceEvidence {
  const program = parseSource(filePath, source);
  const nonliteral: NonliteralModuleReference[] = [];
  const references: ModuleReference[] = [];
  visit(program, (node) => {
    const candidate = toModuleReference(node, source);
    if (!candidate) return;
    if ('specifier' in candidate) references.push(candidate);
    else nonliteral.push(candidate);
  });
  return { nonliteral, references };
}

export function isSupportedSourcePath(filePath: string): boolean {
  return supportedExtensions.some((extension) => filePath.endsWith(extension));
}

function toModuleReference(
  node: AstNode,
  source: string,
): ModuleReference | NonliteralModuleReference | undefined {
  if (node.type === 'ImportDeclaration') return staticImportReference(node);
  if (['ExportAllDeclaration', 'ExportNamedDeclaration'].includes(node.type) && node.source) {
    return staticExportReference(node);
  }
  if (node.type === 'TSImportEqualsDeclaration') return importEqualsReference(node);
  if (node.type === 'ImportExpression') {
    return literalReference('dynamic', node.source, source);
  }
  if (node.type !== 'CallExpression') return undefined;
  const callee = node.callee as AstNode;
  if (callee?.type === 'Import') {
    return literalReference('dynamic', firstArgument(node), source);
  }
  if (callee?.type === 'Identifier' && nameOf(callee) === 'require') {
    return literalReference('require', firstArgument(node), source);
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
  const expression = moduleReference.expression as { readonly value?: unknown } | undefined;
  if (typeof expression?.value !== 'string') return undefined;
  return {
    kind: 'import-equals',
    requiresRuntimeIdentity: true,
    specifier: expression.value,
  };
}

function literalReference(
  kind: NonliteralModuleReference['kind'],
  value: unknown,
  source: string,
): ModuleReference | NonliteralModuleReference {
  const literal = value as AstNode & { readonly value?: unknown };
  if (literal?.type !== 'StringLiteral') {
    return { expression: sourceSlice(source, literal), kind };
  }
  return { kind, requiresRuntimeIdentity: true, specifier: String(literal.value) };
}

function sourceSlice(source: string, node: AstNode | undefined): string {
  if (typeof node?.start !== 'number' || typeof node.end !== 'number') return '<unknown>';
  return source.slice(node.start, node.end);
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
  if (!isSupportedSourcePath(filePath)) {
    throw new Error(`${filePath}: unsupported source extension`);
  }
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

function nameOf(value: unknown): string {
  const node = value as { readonly name?: unknown; readonly value?: unknown } | undefined;
  if (typeof node?.name === 'string') return node.name;
  return typeof node?.value === 'string' ? node.value : '';
}

function isTypeScriptPath(filePath: string): boolean {
  return ['.ts', '.tsx', '.mts', '.cts'].some((extension) => filePath.endsWith(extension));
}
