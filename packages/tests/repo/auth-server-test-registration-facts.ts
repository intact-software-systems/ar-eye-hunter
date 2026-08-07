import {
  type AuthTestAstNode,
  readAstChildren,
  readAstNode,
  readAstNodes,
  readAstString,
  visitAuthTestAst,
} from './auth-server-test-ast.ts';
import {
  createAuthTestExecutionContext,
  type ExecutedAuthTestNode,
  executeAuthTestCallback,
  resolveAuthTestCallback,
  type AuthTestExecutionContext,
} from './auth-server-test-execution.ts';
import type {
  AuthTestSemanticFact,
  ReadRegistrationFactsInput,
} from './auth-server-test-semantic-contracts.ts';

interface Registration {
  readonly callback: AuthTestAstNode | undefined;
  readonly factValue: string;
  readonly nodes: readonly ExecutedAuthTestNode[];
}

interface RegistrationCall {
  readonly callbackExpression: AuthTestAstNode | undefined;
  readonly modifiers: readonly string[];
  readonly root: 'it' | 'test';
  readonly timeoutExpression: AuthTestAstNode | undefined;
  readonly titleExpression: AuthTestAstNode | undefined;
}

export interface AuthTestRegistrationExecution {
  readonly context: string;
  readonly nodes: readonly ExecutedAuthTestNode[];
}

export function readRegistrationAndAssertionFacts(input: ReadRegistrationFactsInput): {
  readonly executions: readonly AuthTestRegistrationExecution[];
  readonly facts: readonly AuthTestSemanticFact[];
  readonly issues: readonly string[];
} {
  const executionContext = createAuthTestExecutionContext(input.modules);
  const registrations = readRegistrations(input, executionContext);
  const issues = [
    ...executionContext.index.issues,
    ...registrations.flatMap(({ factValue }) =>
      factValue.includes('title=<unresolved:')
        ? [`registration.unresolved-title:${factValue}`]
        : [],
    ),
  ];
  const facts: AuthTestSemanticFact[] = registrations.map(({ factValue }) => ({
    kind: 'registration' as const,
    value: factValue,
  }));
  facts.push(...toAssertionFacts(input, registrations));
  return {
    executions: registrations.map(({ factValue, nodes }) => ({ context: factValue, nodes })),
    facts,
    issues,
  };
}

function readRegistrations(
  input: ReadRegistrationFactsInput,
  executionContext: AuthTestExecutionContext,
): readonly Registration[] {
  const registrations: Registration[] = [];
  visitAuthTestAst(input.parsed.root, (node, parent) => {
    if (isCall(node) && !isCalleeOfCall(node, parent)) {
      const call = toRegistrationCall(node, input.canonicalize);
      if (call !== undefined) registrations.push(toRegistration(input, call, executionContext));
    }
  });
  return registrations;
}

function toRegistration(
  input: ReadRegistrationFactsInput,
  call: RegistrationCall,
  executionContext: AuthTestExecutionContext,
): Registration {
  const title =
    call.titleExpression === undefined
      ? '<missing>'
      : (input.resolveString(call.titleExpression) ??
        `<unresolved:${input.canonicalize(call.titleExpression)}>`);
  const timeout =
    call.timeoutExpression === undefined ? '<default>' : input.canonicalize(call.timeoutExpression);
  const callback = resolveAuthTestCallback(call.callbackExpression, executionContext);
  const factValue = [
    `root=${call.root}`,
    `modifiers=${call.modifiers.join('.') || '<none>'}`,
    `title=${title}`,
    `timeout=${timeout}`,
  ].join('|');
  return {
    callback,
    factValue,
    nodes: executeAuthTestCallback(callback, executionContext),
  };
}

function toRegistrationCall(
  call: AuthTestAstNode,
  canonicalize: (expression: AuthTestAstNode) => string,
): RegistrationCall | undefined {
  const callee = readAstNode(call, 'callee');
  if (callee === undefined) return undefined;
  const registrationCallee = readRegistrationCallee(callee, canonicalize);
  if (registrationCallee === undefined || registrationCallee.root === 'describe') return undefined;
  const arguments_ = readAstNodes(call, 'arguments');
  return {
    callbackExpression: arguments_[1],
    modifiers: registrationCallee.modifiers,
    root: registrationCallee.root,
    timeoutExpression: arguments_[2],
    titleExpression: arguments_[0],
  };
}

function readRegistrationCallee(
  expression: AuthTestAstNode,
  canonicalize: (expression: AuthTestAstNode) => string,
):
  { readonly modifiers: readonly string[]; readonly root: 'describe' | 'it' | 'test' } | undefined {
  if (expression.type === 'Identifier') {
    const name = readAstString(expression, 'name');
    return name !== undefined && isRegistrationRoot(name)
      ? { modifiers: [], root: name }
      : undefined;
  }
  if (expression.type === 'MemberExpression' || expression.type === 'OptionalMemberExpression') {
    const owner = readAstNode(expression, 'object');
    const property = readAstNode(expression, 'property');
    if (owner === undefined || property === undefined) return undefined;
    const parent = readRegistrationCallee(owner, canonicalize);
    const modifier = readMemberName(property);
    return parent === undefined || modifier === undefined
      ? undefined
      : { ...parent, modifiers: [...parent.modifiers, modifier] };
  }
  if (isCall(expression)) {
    const callee = readAstNode(expression, 'callee');
    if (callee === undefined) return undefined;
    const parent = readRegistrationCallee(callee, canonicalize);
    if (parent === undefined) return undefined;
    const arguments_ = readAstNodes(expression, 'arguments').map(canonicalize).join(',');
    return {
      ...parent,
      modifiers: [
        ...parent.modifiers.slice(0, -1),
        `${parent.modifiers.at(-1) ?? 'call'}(${arguments_})`,
      ],
    };
  }
  return undefined;
}

function readMemberName(node: AuthTestAstNode): string | undefined {
  if (node.type === 'Identifier') return readAstString(node, 'name');
  if (node.type === 'StringLiteral') return readAstString(node, 'value');
  return undefined;
}

function isRegistrationRoot(value: string): value is 'describe' | 'it' | 'test' {
  return value === 'describe' || value === 'it' || value === 'test';
}

function isCalleeOfCall(call: AuthTestAstNode, parent: AuthTestAstNode | undefined): boolean {
  return parent !== undefined && isCall(parent) && readAstNode(parent, 'callee') === call;
}
function toAssertionExpression(node: AuthTestAstNode): AuthTestAstNode | undefined {
  if (node.type === 'ExpressionStatement') {
    const expression = readAstNode(node, 'expression');
    return expression !== undefined && !isRegistrationExpression(expression)
      ? expression
      : undefined;
  }
  if (node.type === 'ReturnStatement') return readAstNode(node, 'argument');
  if (node.type === 'VariableDeclarator') return readAstNode(node, 'init');
  if (node.type === 'ArrowFunctionExpression') {
    const body = readAstNode(node, 'body');
    return body?.type === 'BlockStatement' ? undefined : body;
  }
  return undefined;
}

function containsExpect(expression: AuthTestAstNode): boolean {
  let found = false;
  descend(expression);
  return found;

  function descend(node: AuthTestAstNode): void {
    if (found || (isFunction(node) && node !== expression)) return;
    if (isCall(node) && readRootIdentifier(readAstNode(node, 'callee')) === 'expect') {
      found = true;
      return;
    }
    for (const child of readAstChildren(node)) descend(child);
  }
}

function isRegistrationExpression(expression: AuthTestAstNode): boolean {
  const callee = isCall(expression) ? readAstNode(expression, 'callee') : undefined;
  return callee !== undefined && readRegistrationCallee(callee, () => '') !== undefined;
}

function toAssertionFacts(
  input: ReadRegistrationFactsInput,
  registrations: readonly Registration[],
): readonly AuthTestSemanticFact[] {
  const facts: AuthTestSemanticFact[] = [];
  for (const registration of registrations) {
    for (const occurrence of registration.nodes) {
      const expression = toAssertionExpression(occurrence.node);
      if (expression !== undefined && containsExpect(expression)) {
        facts.push(
          toAssertionFact(
            registration.factValue,
            input.canonicalizeAssertion(expression, occurrence.resolveBinding),
          ),
        );
      }
    }
  }
  return facts;
}

function toAssertionFact(context: string, canonicalExpression: string): AuthTestSemanticFact {
  return { kind: 'assertion', value: `context=${context}|expression=${canonicalExpression}` };
}

function readRootIdentifier(expression: AuthTestAstNode | undefined): string | undefined {
  if (expression === undefined) return undefined;
  if (expression.type === 'Identifier') return readAstString(expression, 'name');
  if (expression.type === 'MemberExpression' || expression.type === 'OptionalMemberExpression') {
    return readRootIdentifier(readAstNode(expression, 'object'));
  }
  if (isCall(expression)) return readRootIdentifier(readAstNode(expression, 'callee'));
  return undefined;
}

function isCall(node: AuthTestAstNode): boolean {
  return node.type === 'CallExpression' || node.type === 'OptionalCallExpression';
}

function isFunction(node: AuthTestAstNode): boolean {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration' ||
    node.type === 'ObjectMethod' ||
    node.type === 'ClassMethod' ||
    node.type === 'ClassPrivateMethod'
  );
}
