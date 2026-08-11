import { parse } from '@babel/parser';
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';

export function readTestSourceDataflow(source) {
  lexTypeScript(source);
  const program = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] }).program;
  const context = createSourceContext(source, program);
  const blocks = readTestBlocks(program);
  return { context, blocks: blocks.length === 0 ? [program] : blocks };
}

function lexTypeScript(source) {
  const scanner = createScanner(false, undefined, source);
  for (let tokenCount = 0; tokenCount <= source.length * 2; tokenCount += 1) {
    if (scanner.scan() === SyntaxKind.EndOfFile) {
      return;
    }
  }
  throw new Error('TypeScript scanner did not reach end of file');
}

function createSourceContext(source, program) {
  const context = readImportCapabilities(program);
  discoverProductionPaths(program, context);
  discoverReadWrappers(program, context);
  discoverParserWrappers(program, context);
  return { source, ...context };
}

function readImportCapabilities(program) {
  const context = {
    readNames: new Set(['readFileSync', 'readFile', 'readTextFile']),
    parserNames: new Set(),
    parserObjects: new Set(),
    parserWrappers: new Set(),
    paths: new Set(),
    arrays: new Set(),
    namespaces: new Set(),
  };
  walkSyntaxTree(program, (node) => {
    if (node.type !== 'ImportDeclaration') {
      return;
    }
    for (const specifier of node.specifiers) {
      recordFileImport(context, node.source.value, specifier);
      recordParserImport(context, node.source.value, specifier);
    }
  });
  return context;
}

function recordFileImport(context, moduleName, specifier) {
  if (!/^node:fs(?:\/promises)?$/u.test(moduleName)) {
    return;
  }
  if (
    specifier.type === 'ImportSpecifier' &&
    ['readFile', 'readFileSync'].includes(specifier.imported.name)
  ) {
    context.readNames.add(specifier.local.name);
  }
  if (
    specifier.type === 'ImportDefaultSpecifier' ||
    specifier.type === 'ImportNamespaceSpecifier'
  ) {
    context.namespaces.add(specifier.local.name);
  }
  if (specifier.type === 'ImportDefaultSpecifier' && /\/promises$/u.test(moduleName)) {
    context.readNames.add(specifier.local.name);
  }
}

function recordParserImport(context, moduleName, specifier) {
  if (!['@babel/parser', 'typescript', 'ts-morph'].includes(moduleName)) {
    return;
  }
  if (specifier.type === 'ImportSpecifier') {
    context.parserNames.add(specifier.local.name);
  }
  if (specifier.type === 'ImportNamespaceSpecifier') {
    context.namespaces.add(specifier.local.name);
    context.parserObjects.add(specifier.local.name);
  }
  if (specifier.type === 'ImportDefaultSpecifier') {
    context.parserObjects.add(specifier.local.name);
  }
  if (
    specifier.type === 'ImportSpecifier' &&
    ['Project', 'Node', 'SourceFile'].includes(specifier.imported.name)
  ) {
    context.parserObjects.add(specifier.local.name);
  }
}

function discoverProductionPaths(program, context) {
  for (let pass = 0; pass < 4; pass += 1) {
    walkSyntaxTree(program, (node) => {
      if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || !node.init) {
        return;
      }
      if (isProductionPath(node.init, context.paths, context.arrays)) {
        context.paths.add(node.id.name);
      }
      const initializer = unwrapTypeExpression(node.init);
      if (
        initializer.type === 'ArrayExpression' &&
        initializer.elements.some(
          (item) => item && isProductionPath(item, context.paths, context.arrays),
        )
      ) {
        context.arrays.add(node.id.name);
      }
    });
  }
}

function discoverReadWrappers(program, context) {
  for (let pass = 0; pass < 3; pass += 1) {
    walkSyntaxTree(program, (node) => {
      const name = functionName(node);
      if (name && functionCallsRead({ node, context })) {
        context.readNames.add(name);
      }
    });
  }
}

function discoverParserWrappers(program, context) {
  for (let pass = 0; pass < 3; pass += 1) {
    walkSyntaxTree(program, (node) => {
      const name = functionName(node);
      if (name && functionCallsParser({ node, context })) {
        context.parserWrappers.add(name);
      }
    });
  }
}

function functionCallsRead({ node, context }) {
  let found = false;
  walkSyntaxTree(node.body, (child) => {
    if (child.type === 'CallExpression' && isReadCall(calleeName(child.callee), context)) {
      found = true;
    }
  });
  return found;
}

function functionCallsParser({ node, context }) {
  let found = false;
  walkSyntaxTree(node.body, (child) => {
    if (
      child.type === 'CallExpression' &&
      isImportedParserCall(calleeName(child.callee), context)
    ) {
      found = true;
    }
  });
  return found;
}

function functionName(node) {
  if (node.type === 'FunctionDeclaration') {
    return node.id?.name;
  }
  if (
    node.type === 'VariableDeclarator' &&
    node.id.type === 'Identifier' &&
    ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)
  ) {
    return node.id.name;
  }
  return undefined;
}

function readTestBlocks(program) {
  const blocks = [];
  walkSyntaxTree(program, (node) => {
    if (node.type !== 'CallExpression' || !isTestCallee(node.callee)) {
      return;
    }
    const callback = node.arguments.find(isFunctionExpression);
    if (callback) {
      blocks.push(callback.body);
    }
  });
  return blocks;
}

function isTestCallee(callee) {
  const name = calleeName(callee);
  return name === 'it' || name === 'test' || name === 'Deno.test';
}

export function isProductionPath(node, paths, arrays) {
  if (!node) {
    return false;
  }
  node = unwrapTypeExpression(node);
  if (node.type === 'StringLiteral' || node.type === 'TemplateLiteral') {
    const value = node.value ?? node.quasis?.map((item) => item.value.cooked).join('');
    return /^(?:apps|packages)\//u.test(value);
  }
  if (node.type === 'Identifier') {
    return paths.has(node.name) || arrays.has(node.name);
  }
  if (node.type === 'MemberExpression') {
    return isProductionPath(node.object, paths, arrays);
  }
  if (node.type === 'ArrayExpression') {
    return node.elements.some((item) => item && isProductionPath(item, paths, arrays));
  }
  if (
    node.type === 'CallExpression' &&
    /(?:path\.)?(?:join|resolve)$/u.test(calleeName(node.callee))
  ) {
    return node.arguments.some(
      (argument) =>
        isProductionPath(argument, paths, arrays) ||
        (argument?.type === 'StringLiteral' && /^(?:apps|packages)$/u.test(argument.value)),
    );
  }
  return false;
}

function unwrapTypeExpression(node) {
  while (node?.type === 'TSAsExpression' || node?.type === 'TSTypeAssertion') {
    node = node.expression;
  }
  return node;
}

export function isReadCall(name, context) {
  return (
    context.readNames.has(name) ||
    [...context.namespaces].some(
      (namespace) =>
        name === `${namespace}.readFile` ||
        name === `${namespace}.readFileSync` ||
        name === `${namespace}.promises.readFile`,
    ) ||
    name === 'Deno.readTextFile'
  );
}

export function isAstParserCall(name, context) {
  return context.parserWrappers.has(name) || isImportedParserCall(name, context);
}

function isImportedParserCall(name, context) {
  return (
    context.parserNames.has(name) ||
    [...context.parserObjects].some(
      (parserObject) =>
        name.startsWith(`${parserObject}.createSourceFile`) ||
        name.startsWith(`${parserObject}.parse`),
    ) ||
    [...context.namespaces].some(
      (namespace) => name === `${namespace}.createSourceFile` || name === `${namespace}.parse`,
    ) ||
    name.endsWith('.createSourceFile')
  );
}

export function containsReadCall(node, context) {
  let found = false;
  walkSyntaxTree(node, (child) => {
    if (child.type === 'CallExpression' && isReadCall(calleeName(child.callee), context)) {
      found = true;
    }
  });
  return found;
}

export function usesSource(node, sourceValues) {
  let found = false;
  walkSyntaxTree(node, (child) => {
    if (child.type === 'Identifier' && sourceValues.has(child.name)) {
      found = true;
    }
  });
  return found;
}

export function isFunctionExpression(node) {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression';
}

export function memberPropertyName(node) {
  if (node?.type !== 'MemberExpression' && node?.type !== 'OptionalMemberExpression') {
    return '';
  }
  if (node.computed) {
    return node.property?.value ?? '';
  }
  return node.property?.name ?? '';
}

export function calleeName(node) {
  if (!node) {
    return '';
  }
  if (node.type === 'Identifier') {
    return node.name;
  }
  if (node.type === 'MemberExpression') {
    const property = node.computed ? node.property.value : node.property.name;
    return `${calleeName(node.object)}.${property}`;
  }
  if (node.type === 'OptionalMemberExpression') {
    return `${calleeName(node.object)}.${node.property.name}`;
  }
  return '';
}

export function walkSyntaxTree(node, visit, parent = undefined) {
  if (!node || typeof node !== 'object') {
    return;
  }
  if (typeof node.type === 'string') {
    visit(node, parent);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walkSyntaxTree(item, visit, node);
      }
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      walkSyntaxTree(value, visit, node);
    }
  }
}
