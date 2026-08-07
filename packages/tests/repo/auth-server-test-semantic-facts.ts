import {
  type AuthTestAstNode,
  parseAuthTestSource,
  readAstNode,
  readAstNodes,
  readAstString,
  toCanonicalAst,
  visitAuthTestAst,
} from './auth-server-test-ast.ts';
import {
  toCanonicalAssertionAst,
  type AuthTestBindingResolver,
} from './auth-server-test-expression-canonicalization.ts';
import { readAuthTestDeclarationFacts } from './auth-server-test-declaration-facts.ts';
import { isCanonicalAuthTestOperationBoundary } from './auth-server-test-call-canonicalization.ts';
import {
  toCanonicalMutationAst,
  toCanonicalSetupAst,
} from './auth-server-test-effect-canonicalization.ts';
import type { ExecutedAuthTestNode } from './auth-server-test-execution.ts';
import { readRegistrationAndAssertionFacts } from './auth-server-test-registration-facts.ts';
import { readAuthTestModuleGraph } from './auth-server-test-module-graph.ts';
import {
  readAuthTestStringConstants,
  readDescribeOwnedAuthTestStrings,
  resolveAuthTestRegistrationString,
} from './auth-server-test-registration-strings.ts';
import type {
  AuthTestSemanticFact,
  AuthTestSemanticRead,
} from './auth-server-test-semantic-contracts.ts';

interface ReadAuthTestSemanticFactsInput {
  readonly ownerPath: string;
  readonly source: string;
  readonly supportingSources?: Readonly<Record<string, string>>;
}

export function readAuthTestSemanticFacts(
  input: ReadAuthTestSemanticFactsInput,
): AuthTestSemanticRead {
  const parseRead = parseAuthTestSource(input.ownerPath, input.source);
  if (parseRead.parsed === undefined) return { facts: [], issues: parseRead.issues };
  const parsed = parseRead.parsed;
  const graphRead =
    input.supportingSources === undefined
      ? { issues: [], modules: [{ path: input.ownerPath, root: parsed.root, imports: [] }] }
      : readAuthTestModuleGraph(input.ownerPath, parsed.root, input.supportingSources);
  const canonicalize = (expression: AuthTestAstNode): string => toCanonicalAst(expression, parsed);
  const stringValues = readAuthTestStringConstants(parsed.root);
  const describeOwnedStrings = readDescribeOwnedAuthTestStrings(parsed.root, stringValues);
  const registrationRead = readRegistrationAndAssertionFacts({
    parsed,
    modules: graphRead.modules,
    canonicalize,
    canonicalizeAssertion: toCanonicalAssertionAst,
    resolveString: (expression) => resolveAuthTestRegistrationString(expression, stringValues),
  });
  return {
    facts: [
      ...readAuthTestDeclarationFacts(parsed.root),
      ...registrationRead.facts,
      ...readSyntaxFacts(parsed.root, registrationRead.executions, describeOwnedStrings),
    ],
    issues: [...graphRead.issues, ...registrationRead.issues],
  };
}

function isTransparentExpression(expression: AuthTestAstNode): boolean {
  return (
    expression.type === 'ParenthesizedExpression' ||
    expression.type === 'TSAsExpression' ||
    expression.type === 'TSSatisfiesExpression' ||
    expression.type === 'TSTypeAssertion'
  );
}

function readSyntaxFacts(
  root: AuthTestAstNode,
  executions: readonly { readonly nodes: readonly ExecutedAuthTestNode[] }[],
  describeOwnedStrings: ReadonlySet<AuthTestAstNode>,
): readonly AuthTestSemanticFact[] {
  const facts: AuthTestSemanticFact[] = [];
  const occurrences = executions.flatMap(({ nodes }) => nodes);
  const executedNodes = new Set(occurrences.map(({ node }) => node));
  const expandedHelpers = new Set(
    occurrences.filter(({ expandsHelper }) => expandsHelper).map(({ node }) => node),
  );
  visitAuthTestAst(root, (node, parent) => {
    const fact = executedNodes.has(node)
      ? undefined
      : toLiteralFact(node, parent, describeOwnedStrings);
    if (fact !== undefined) facts.push(fact);
    if (isMutationExpression(node) && !executedNodes.has(node)) {
      facts.push(toMutationFact(node, () => undefined));
    }
    if (node.type === 'ExpressionStatement' && !executedNodes.has(node)) {
      const expression = readAstNode(node, 'expression');
      const expressionFact =
        expression === undefined ? undefined : toRootExpressionFact(expression, () => undefined);
      if (expressionFact !== undefined) facts.push(expressionFact);
    }
  });
  for (const occurrence of occurrences) {
    const fact = toLiteralFact(occurrence.node, occurrence.parent, describeOwnedStrings);
    if (fact !== undefined) facts.push(fact);
    facts.push(...readResolvedLiteralFacts(occurrence));
    if (isMutationExpression(occurrence.node)) {
      facts.push(toMutationFact(occurrence.node, occurrence.resolveBinding));
    }
    if (occurrence.node.type === 'ExpressionStatement') {
      const expression = readAstNode(occurrence.node, 'expression');
      if (expression === undefined || isExpandedHelperRoot(expression, expandedHelpers)) continue;
      const expressionFact = toRootExpressionFact(expression, occurrence.resolveBinding);
      if (expressionFact !== undefined) facts.push(expressionFact);
    }
  }
  return facts;
}

function readResolvedLiteralFacts(
  occurrence: ExecutedAuthTestNode,
): readonly AuthTestSemanticFact[] {
  if (
    occurrence.node.type !== 'Identifier' ||
    !isValueIdentifier(occurrence.node, occurrence.parent)
  ) {
    return [];
  }
  const name = readAstString(occurrence.node, 'name');
  const unresolved = name === undefined ? undefined : occurrence.resolveBinding(name);
  const value = unresolved === undefined ? undefined : unwrapLiteral(unresolved);
  if (value === undefined || value === occurrence.node) return [];
  const fact = toLiteralFact(value, undefined, new Set());
  return fact === undefined ? [] : [fact];
}

function unwrapLiteral(node: AuthTestAstNode): AuthTestAstNode {
  if (!isTransparentExpression(node)) return node;
  const expression = readAstNode(node, 'expression');
  return expression === undefined ? node : unwrapLiteral(expression);
}

function isValueIdentifier(node: AuthTestAstNode, parent: AuthTestAstNode | undefined): boolean {
  if (parent === undefined) return true;
  if (parent.type === 'VariableDeclarator' && readAstNode(parent, 'id') === node) return false;
  if (readAstNodes(parent, 'params').includes(node)) return false;
  if (
    (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') &&
    readAstNode(parent, 'property') === node &&
    parent.computed !== true
  ) {
    return false;
  }
  if (parent.type === 'ObjectProperty' && readAstNode(parent, 'key') === node) {
    return readAstNode(parent, 'value') === node;
  }
  return !(isCall(parent) && readAstNode(parent, 'callee') === node);
}

function isExpandedHelperRoot(
  expression: AuthTestAstNode,
  expandedHelpers: ReadonlySet<AuthTestAstNode>,
): boolean {
  let current = expression;
  while (current.type === 'AwaitExpression' || isTransparentExpression(current)) {
    const inner = readAstNode(current, 'argument') ?? readAstNode(current, 'expression');
    if (inner === undefined) break;
    current = inner;
  }
  if (!expandedHelpers.has(current)) return false;
  const callee = isCall(current) ? readAstNode(current, 'callee') : undefined;
  const name = readIdentifierName(callee);
  return name === undefined || !isCanonicalAuthTestOperationBoundary(name);
}

function toLiteralFact(
  node: AuthTestAstNode,
  parent: AuthTestAstNode | undefined,
  describeOwnedStrings: ReadonlySet<AuthTestAstNode>,
): AuthTestSemanticFact | undefined {
  if (
    node.type === 'StringLiteral' &&
    !describeOwnedStrings.has(node) &&
    isCountedString(node, parent)
  ) {
    return { kind: 'string-literal', value: readAstString(node, 'value') ?? '' };
  }
  if (node.type === 'TemplateElement' && !describeOwnedStrings.has(node)) {
    const value = readTemplateElementRaw(node);
    return value === '' ? undefined : { kind: 'string-literal', value };
  }
  if (node.type === 'NumericLiteral') {
    return { kind: 'numeric-literal', value: String(node.value) };
  }
  if (node.type === 'RegExpLiteral') {
    return {
      kind: 'regex-literal',
      value: `/${readAstString(node, 'pattern') ?? ''}/${readAstString(node, 'flags') ?? ''}`,
    };
  }
  return undefined;
}

function toRootExpressionFact(
  expression: AuthTestAstNode,
  resolveBinding: AuthTestBindingResolver,
): AuthTestSemanticFact | undefined {
  const root = readRootIdentifier(expression);
  if (
    root === 'describe' ||
    root === 'it' ||
    root === 'test' ||
    containsExpect(expression) ||
    isMutationExpression(unwrapRootExpression(expression))
  ) {
    return undefined;
  }
  return {
    kind: 'setup-expression',
    value: toCanonicalSetupAst(expression, resolveBinding),
  };
}

function toMutationFact(
  expression: AuthTestAstNode,
  resolveBinding: AuthTestBindingResolver,
): AuthTestSemanticFact {
  return {
    kind: 'mutation-expression',
    value: toCanonicalMutationAst(expression, resolveBinding),
  };
}

function unwrapRootExpression(expression: AuthTestAstNode): AuthTestAstNode {
  let current = expression;
  while (current.type === 'AwaitExpression' || isTransparentExpression(current)) {
    const inner = readAstNode(current, 'argument') ?? readAstNode(current, 'expression');
    if (inner === undefined) break;
    current = inner;
  }
  return current;
}

function isCountedString(node: AuthTestAstNode, parent: AuthTestAstNode | undefined): boolean {
  if (parent === undefined) return true;
  if (isModuleSpecifier(node, parent)) return false;
  if (
    (parent.type === 'ImportDeclaration' ||
      parent.type === 'ExportNamedDeclaration' ||
      parent.type === 'ExportAllDeclaration') &&
    readAstNode(parent, 'source') === node
  ) {
    return false;
  }
  return !isDescribeTitle(node, parent);
}

function isModuleSpecifier(node: AuthTestAstNode, parent: AuthTestAstNode): boolean {
  if (parent.type === 'TSExternalModuleReference') return true;
  if (parent.type === 'ImportExpression' && readAstNode(parent, 'source') === node) return true;
  if (!isCall(parent) || readAstNodes(parent, 'arguments')[0] !== node) return false;
  const callee = readAstNode(parent, 'callee');
  return (
    callee?.type === 'Import' ||
    (callee?.type === 'Identifier' && readAstString(callee, 'name') === 'require')
  );
}

function isDescribeTitle(node: AuthTestAstNode, parent: AuthTestAstNode): boolean {
  const callee = isCall(parent) ? readAstNode(parent, 'callee') : undefined;
  return (
    isCall(parent) &&
    readAstNodes(parent, 'arguments')[0] === node &&
    callee !== undefined &&
    readRootIdentifier(callee) === 'describe'
  );
}

function readRootIdentifier(expression: AuthTestAstNode): string | undefined {
  if (expression.type === 'Identifier') return readAstString(expression, 'name');
  if (expression.type === 'MemberExpression' || expression.type === 'OptionalMemberExpression') {
    const object = readAstNode(expression, 'object');
    return object === undefined ? undefined : readRootIdentifier(object);
  }
  if (isCall(expression)) {
    const callee = readAstNode(expression, 'callee');
    return callee === undefined ? undefined : readRootIdentifier(callee);
  }
  if (expression.type === 'AwaitExpression' || expression.type === 'TSAsExpression') {
    const inner = readAstNode(expression, 'argument') ?? readAstNode(expression, 'expression');
    return inner === undefined ? undefined : readRootIdentifier(inner);
  }
  return undefined;
}

function containsExpect(expression: AuthTestAstNode): boolean {
  let found = false;
  visitAuthTestAst(expression, (node) => {
    if (!found && isCall(node)) {
      const callee = readAstNode(node, 'callee');
      found = callee !== undefined && readRootIdentifier(callee) === 'expect';
    }
  });
  return found;
}

function isMutationExpression(node: AuthTestAstNode): boolean {
  return (
    node.type === 'AssignmentExpression' ||
    node.type === 'UpdateExpression' ||
    (node.type === 'UnaryExpression' && readAstString(node, 'operator') === 'delete')
  );
}

function isCall(node: AuthTestAstNode): boolean {
  return node.type === 'CallExpression' || node.type === 'OptionalCallExpression';
}

function readIdentifierName(node: AuthTestAstNode | undefined): string | undefined {
  return node?.type === 'Identifier' ? readAstString(node, 'name') : undefined;
}

function readTemplateElementRaw(node: AuthTestAstNode): string {
  const value = node.value;
  if (typeof value !== 'object' || value === null) return '';
  const raw = (value as { readonly raw?: unknown }).raw;
  return typeof raw === 'string' ? raw : '';
}
