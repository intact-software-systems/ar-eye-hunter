import { parse } from '@babel/parser';

import {
  createConstructionScopeModel,
  resolveConstructionBinding,
} from './construction-scope-model.mjs';
import { lineFromOffset, lineOffsets } from './source-text.mjs';

export const constructionRuleIds = Object.freeze({
  forwardCapture: 'construction.forward-capture',
  definiteAssignment: 'construction.definite-assignment',
  nestedCallbackDepth: 'control.nested-callback-depth',
  passThrough: 'abstraction.pass-through',
});
const transparentExpressionTypes = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSInstantiationExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'TypeCastExpression',
]);
export function scanConstructionRules(source, options) {
  const program = parseProgram(source);
  const model = createConstructionScopeModel(program);
  const findings = scanForwardCaptures(program, model, lineOffsets(source.raw));
  if (options.details) {
    findings.push(...scanDefiniteAssignments(model));
    findings.push(...scanNestedCallbackDepth(program));
    findings.push(...scanPassThroughCallables(program));
  }
  return findings
    .toSorted((left, right) => left.start - right.start || left.ruleId.localeCompare(right.ruleId))
    .map(({ ruleId, message }) => ({ ruleId, message }));
}
function parseProgram(source) {
  const file = source.file.toLowerCase();
  const plugins = file.endsWith('.tsx')
    ? ['typescript', 'jsx']
    : file.endsWith('.mjs')
      ? []
      : ['typescript'];
  return parse(source.raw, {
    sourceFilename: source.file,
    sourceType: 'module',
    plugins,
  }).program;
}
function scanForwardCaptures(program, model, offsets) {
  const findings = [];
  walk(program, (node) => {
    if (!isCallExpression(node)) {
      return;
    }
    const constructionName = terminalCalleeName(node.callee);
    if (constructionName === undefined || !/^create[A-Z]/u.test(constructionName)) {
      return;
    }
    const reported = new Set();
    for (const callback of node.arguments.flatMap(findCallbacks)) {
      for (const reference of collectCallbackReferences(callback)) {
        const binding = resolveConstructionBinding(
          model.scopeByNode.get(reference),
          reference.name,
        );
        if (binding === undefined || reported.has(binding)) {
          continue;
        }
        const firstValueStart = [binding.initializerStart, ...binding.assignmentStarts]
          .filter((start) => start !== undefined)
          .toSorted((left, right) => left - right)[0];
        if (firstValueStart === undefined || firstValueStart <= node.end) {
          continue;
        }
        reported.add(binding);
        findings.push({
          start: node.start,
          ruleId: constructionRuleIds.forwardCapture,
          message:
            `Review captured '${binding.name}' in ${constructionName}: declaration line ` +
            `${lineFromOffset(offsets, binding.declarationStart)}, assignment line ` +
            `${lineFromOffset(offsets, firstValueStart)} follows the construction call.`,
        });
      }
    }
  });
  return findings;
}
function findCallbacks(argument) {
  const node = unwrapExpression(argument);
  if (!isNode(node)) {
    return [];
  }
  if (isFunctionLike(node)) {
    return [node];
  }
  if (node.type === 'ObjectExpression') {
    return node.properties.flatMap(findCallbacks);
  }
  if (node.type === 'ObjectProperty') {
    const keyCallbacks = node.computed ? findCallbacks(node.key) : [];
    return [...keyCallbacks, ...findCallbacks(node.value)];
  }
  if (node.type === 'SpreadElement') {
    return findCallbacks(node.argument);
  }
  return [];
}
function collectCallbackReferences(callback) {
  const references = [];
  forEachChild(callback, (child, key) =>
    collectReferences({
      node: child,
      parent: callback,
      key,
      references,
    }),
  );
  return references;
}
function collectReferences(input) {
  if (!isNode(input.node) || isFunctionLike(input.node)) {
    return;
  }
  if (transparentExpressionTypes.has(input.node.type)) {
    collectReferences({ ...input, node: input.node.expression });
    return;
  }
  if (input.node.type.startsWith('TS') || input.node.type === 'TypeAnnotation') {
    return;
  }
  if (input.node.type === 'Identifier' && isReferenceIdentifier(input.parent, input.key)) {
    input.references.push(input.node);
  }
  forEachChild(input.node, (child, key) =>
    collectReferences({
      ...input,
      node: child,
      parent: input.node,
      key,
    }),
  );
}
function scanDefiniteAssignments(model) {
  return model.scopes.flatMap((scope) =>
    [...scope.bindings.values()]
      .filter((binding) => binding.definite)
      .map((binding) => ({
        start: binding.declarationStart,
        ruleId: constructionRuleIds.definiteAssignment,
        message: `Review definite-assignment binding '${binding.name}'.`,
      })),
  );
}
function scanNestedCallbackDepth(program) {
  const { callbacks, parents } = collectCallArgumentCallbacks(program);
  const callbackSet = new Set(callbacks);
  const depths = new Map(
    callbacks.map((callback) => [callback, callbackDepth(callback, callbackSet)]),
  );
  return callbacks
    .filter((callback) => depths.get(callback) >= 3)
    .filter((callback) => !hasOffendingAncestor(callback, parents, depths))
    .map((callback) => ({
      start: callback.start,
      ruleId: constructionRuleIds.nestedCallbackDepth,
      message: `Callback depth ${depths.get(callback)} is a review signal.`,
    }));
}
function collectCallArgumentCallbacks(program) {
  const callbackSet = new Set();
  const parents = new WeakMap();
  walk(program, (node, parent) => {
    if (parent !== undefined) {
      parents.set(node, parent);
    }
    if (isCallExpression(node) || node.type === 'NewExpression') {
      node.arguments.forEach((argument) => collectArgumentCallbacks(argument, callbackSet));
    }
  });
  const callbacks = [...callbackSet].toSorted((left, right) => left.start - right.start);
  return { callbacks, parents };
}
function collectArgumentCallbacks(node, callbacks) {
  const expression = unwrapExpression(node);
  if (!isNode(expression)) {
    return;
  }
  if (isDepthCallback(expression)) {
    callbacks.add(expression);
    return;
  }
  if (expression.type === 'ObjectExpression') {
    expression.properties.forEach((property) => collectArgumentCallbacks(property, callbacks));
  } else if (expression.type === 'ObjectProperty') {
    collectArgumentCallbacks(expression.value, callbacks);
  } else if (expression.type === 'SpreadElement') {
    collectArgumentCallbacks(expression.argument, callbacks);
  }
}
function callbackDepth(callback, callbackSet) {
  let childDepth = 0;
  forEachChild(callback, (child) => {
    childDepth = Math.max(childDepth, nestedCallbackDepth(child, callbackSet));
  });
  return childDepth + 1;
}
function nestedCallbackDepth(node, callbackSet) {
  if (!isNode(node)) {
    return 0;
  }
  if (callbackSet.has(node)) {
    return callbackDepth(node, callbackSet);
  }
  let maximum = 0;
  forEachChild(node, (child) => {
    maximum = Math.max(maximum, nestedCallbackDepth(child, callbackSet));
  });
  return maximum;
}
function hasOffendingAncestor(callback, parents, depths) {
  let current = parents.get(callback);
  while (current !== undefined) {
    if ((depths.get(current) ?? 0) >= 3) {
      return true;
    }
    current = parents.get(current);
  }
  return false;
}
function scanPassThroughCallables(program) {
  const findings = [];
  walk(program, (node, parent) => {
    const name = callableName(node, parent);
    if (name !== undefined && isPassThroughCallable(node)) {
      findings.push({
        start: node.start,
        ruleId: constructionRuleIds.passThrough,
        message: `Review pass-through callable '${name}' for a real boundary.`,
      });
    }
  });
  return findings;
}
function callableName(node, parent) {
  if (node.type === 'FunctionDeclaration' && node.id !== null) {
    return node.id.name;
  }
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
      return parent.id.name;
    }
    if (parent?.type === 'AssignmentExpression' && parent.left.type === 'Identifier') {
      return parent.left.name;
    }
    return node.type === 'FunctionExpression' ? node.id?.name : undefined;
  }
  if (node.type === 'ObjectMethod') {
    return propertyName(node.key, node.computed);
  }
  return undefined;
}
function isPassThroughCallable(node) {
  if (!isFunctionLike(node) || node.params.some((parameter) => parameter.type !== 'Identifier')) {
    return false;
  }
  const expressionBody =
    node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement';
  const statement =
    node.body?.type === 'BlockStatement' && node.body.body.length === 1
      ? node.body.body[0]
      : undefined;
  const returned = expressionBody
    ? node.body
    : statement?.type === 'ReturnStatement'
      ? statement.argument
      : undefined;
  const expression = unwrapExpression(returned);
  const call = unwrapExpression(
    expression?.type === 'AwaitExpression' ? expression.argument : expression,
  );
  return (
    call?.type === 'CallExpression' &&
    call.arguments.length === node.params.length &&
    call.arguments.every(
      (argument, index) =>
        argument.type === 'Identifier' && argument.name === node.params[index].name,
    )
  );
}
function terminalCalleeName(callee) {
  const expression = unwrapExpression(callee);
  if (expression.type === 'Identifier') {
    return expression.name;
  }
  if (expression.type === 'MemberExpression' || expression.type === 'OptionalMemberExpression') {
    return propertyName(expression.property, expression.computed);
  }
  return undefined;
}
function unwrapExpression(node) {
  let current = node;
  while (isNode(current) && transparentExpressionTypes.has(current.type)) {
    current = current.expression;
  }
  return current;
}
function propertyName(property, computed) {
  if (!computed && property.type === 'Identifier') {
    return property.name;
  }
  return property.type === 'StringLiteral' ? property.value : undefined;
}
function isReferenceIdentifier(parent, key) {
  const member = parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression';
  const property = parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod';
  return !(
    (parent.type === 'VariableDeclarator' && key === 'id') ||
    (isFunctionLike(parent) && (key === 'id' || key === 'params')) ||
    (member && key === 'property' && !parent.computed) ||
    (property && key === 'key' && !parent.computed) ||
    ['ImportSpecifier', 'ExportSpecifier', 'LabeledStatement'].includes(parent.type)
  );
}
function isFunctionLike(node) {
  return [
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ObjectMethod',
    'ClassMethod',
    'ClassPrivateMethod',
  ].includes(node.type);
}
function isDepthCallback(node) {
  return node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
}
function isCallExpression(node) {
  return node.type === 'CallExpression' || node.type === 'OptionalCallExpression';
}
function walk(node, visit, parent = undefined) {
  if (!isNode(node) || visit(node, parent) === false) {
    return;
  }
  forEachChild(node, (child) => walk(child, visit, node));
}
function forEachChild(node, visit) {
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'extra', 'tokens', 'comments'].includes(key)) {
      continue;
    }
    if (Array.isArray(value)) {
      value.filter(isNode).forEach((child) => visit(child, key));
    } else if (isNode(value)) {
      visit(value, key);
    }
  }
}
function isNode(value) {
  return value !== null && typeof value === 'object' && typeof value.type === 'string';
}
