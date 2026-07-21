import * as ts from 'typescript/unstable/ast';
import { expect } from 'vitest';

export interface ExpectedCall {
  readonly callee: string;
  readonly arguments?: readonly string[];
  readonly awaited?: boolean;
}

interface NamedCall {
  readonly name: string;
  readonly node: ts.CallExpression;
}

export function findFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const matches: ts.FunctionDeclaration[] = [];
  walk(source, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      matches.push(node);
    }
    return true;
  });
  expect(matches, `function ${name}`).toHaveLength(1);
  return matches[0]!;
}

export function findCall(
  source: ts.SourceFile,
  owner: ts.Node,
  expected: ExpectedCall,
): ts.CallExpression {
  const matches = callsWithin(owner).filter(({ node }) => {
    if (normalize(node.expression.getText(source)) !== normalize(expected.callee)) {
      return false;
    }
    if (expected.awaited !== undefined && isAwaited(node) !== expected.awaited) {
      return false;
    }
    return (
      expected.arguments === undefined ||
      JSON.stringify(node.arguments.map((argument) => normalize(argument.getText(source)))) ===
        JSON.stringify(expected.arguments.map(normalize))
    );
  });
  expect(matches, `${expected.callee} ${JSON.stringify(expected.arguments ?? [])}`).toHaveLength(1);
  return matches[0]!.node;
}

export function findIf(owner: ts.Node, condition: string, source: ts.SourceFile): ts.IfStatement {
  const matches: ts.IfStatement[] = [];
  walkOwned(owner, (node) => {
    if (ts.isIfStatement(node) && normalize(node.expression.getText(source)) === condition) {
      matches.push(node);
    }
  });
  expect(matches, condition).toHaveLength(1);
  return matches[0]!;
}

export function findOutboxEffectPush(
  source: ts.SourceFile,
  owner: ts.FunctionLikeDeclaration,
): ts.CallExpression {
  const matches = callsWithin(owner).filter(({ node }) => {
    if (normalize(node.expression.getText(source)) !== 'effects.push') {
      return false;
    }
    const argument = node.arguments[0];
    return Boolean(
      argument &&
      ts.isObjectLiteralExpression(argument) &&
      argument.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          normalize(property.name.getText(source)) === 'effectId' &&
          normalize(property.initializer.getText(source)) === "'outbox'",
      ),
    );
  });
  expect(matches, 'outbox effect push').toHaveLength(1);
  return matches[0]!.node;
}

export function findVariableBinding(node: ts.Node, owner: ts.Node): string | undefined {
  let current = node.parent;
  while (current && current !== owner) {
    if (ts.isVariableDeclaration(current)) {
      return current.name.getText();
    }
    current = current.parent;
  }
  return undefined;
}

export function findForOfAncestor(node: ts.Node, owner: ts.Node): ts.ForOfStatement {
  let current = node.parent;
  while (current && current !== owner) {
    if (ts.isForOfStatement(current)) {
      return current;
    }
    current = current.parent;
  }
  throw new Error(`Missing for-of classification for ${node.getText()}`);
}

export function findSingleReturn(node: ts.Node): ts.ReturnStatement {
  const returns: ts.ReturnStatement[] = [];
  walk(node, (candidate) => {
    if (ts.isReturnStatement(candidate)) {
      returns.push(candidate);
    }
    return true;
  });
  expect(returns, 'capable branch return').toHaveLength(1);
  return returns[0]!;
}

export function ownedCalls(owner: ts.Node): readonly NamedCall[] {
  return callsWithin(owner);
}

export function callName(call: ts.CallExpression): string {
  if (ts.isIdentifier(call.expression)) {
    return call.expression.text;
  }
  if (ts.isPropertyAccessExpression(call.expression)) {
    return call.expression.name.text;
  }
  return normalize(call.expression.getText());
}

export function callCallback(
  call: ts.CallExpression,
  source: ts.SourceFile,
): ts.FunctionLikeDeclaration {
  const callback = call.arguments[0];
  expect(callback && isFunction(callback), callback?.getText(source)).toBe(true);
  return callback as ts.FunctionLikeDeclaration;
}

export function isAwaited(call: ts.CallExpression): boolean {
  return ts.isAwaitExpression(call.parent);
}

export function within(node: ts.Node, container: ts.Node): boolean {
  return node.pos >= container.pos && node.end <= container.end;
}

export function hasKind(node: ts.Node, kind: ts.SyntaxKind): boolean {
  let found = false;
  walk(node, (candidate) => {
    if (candidate.kind === kind) {
      found = true;
    }
    return !found;
  });
  return found;
}

function callsWithin(owner: ts.Node): readonly NamedCall[] {
  const calls: NamedCall[] = [];
  walkOwned(owner, (node) => {
    if (ts.isCallExpression(node)) {
      calls.push({ name: callName(node), node });
    }
  });
  return calls.sort((left, right) => left.node.pos - right.node.pos);
}

function walkOwned(owner: ts.Node, visit: (node: ts.Node) => void): void {
  walk(owner, (node) => {
    if (node !== owner && isFunction(node)) {
      return false;
    }
    visit(node);
    return true;
  });
}

function walk(node: ts.Node, visit: (node: ts.Node) => boolean): void {
  if (!visit(node)) {
    return;
  }
  node.forEachChild((child) => {
    walk(child, visit);
    return undefined;
  });
}

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

function normalize(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s*\.\s*/g, '.')
    .trim();
}
