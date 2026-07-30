export function createConstructionScopeModel(program) {
  const root = {
    parent: undefined,
    bindings: new Map(),
    functionLike: true,
    start: program.start,
  };
  const scopeByNode = new WeakMap([[program, root]]);
  const scopes = [root];
  collectScopeDeclarations(program, root, { scopeByNode, scopes });
  collectBindingAssignments(program, root, scopeByNode);
  return { scopeByNode, scopes };
}

export function resolveConstructionBinding(scope, name) {
  let current = scope;
  while (current !== undefined) {
    const binding = current.bindings.get(name);
    if (binding !== undefined) {
      return binding;
    }
    current = current.parent;
  }
  return undefined;
}

function collectScopeDeclarations(node, scope, model) {
  let current = scope;
  if (isFunctionLike(node)) {
    if (node.type === 'FunctionDeclaration' && node.id !== null) {
      declarePattern(node.id, scope, {
        definite: false,
        initializerStart: scope.start,
      });
    }
    current = {
      parent: scope,
      bindings: new Map(),
      functionLike: true,
      start: node.start,
    };
    model.scopes.push(current);
    model.scopeByNode.set(node, current);
    for (const parameter of node.params ?? []) {
      declarePattern(parameter, current, {
        definite: false,
        initializerStart: parameter.start,
      });
    }
    if (node.type === 'FunctionExpression' && node.id !== null) {
      declarePattern(node.id, current, { definite: false, initializerStart: node.start });
    }
  } else if (isLexicalScope(node) || node.type === 'ClassExpression') {
    current = {
      parent: scope,
      bindings: new Map(),
      functionLike: false,
      start: node.start,
    };
    model.scopes.push(current);
    model.scopeByNode.set(node, current);
  } else {
    model.scopeByNode.set(node, current);
  }
  if (node.type === 'VariableDeclaration') {
    const declarationScope = node.kind === 'var' ? nearestFunctionScope(current) : current;
    for (const declaration of node.declarations) {
      declarePattern(declaration.id, declarationScope, {
        definite: declaration.definite === true,
        initializerStart: declaration.init?.start,
      });
    }
  } else if (node.type === 'CatchClause' && node.param !== null) {
    declarePattern(node.param, current, {
      definite: false,
      initializerStart: node.param.start,
    });
  } else if (node.type === 'ClassDeclaration' && node.id !== null) {
    declarePattern(node.id, current, { definite: false, initializerStart: node.start });
  } else if (node.type === 'ClassExpression' && node.id !== null) {
    declarePattern(node.id, current, { definite: false, initializerStart: node.start });
  } else if (isRuntimeTypeScriptDeclaration(node)) {
    declarePattern(node.id, current, { definite: false, initializerStart: node.start });
  }
  forEachChild(node, (child) => collectScopeDeclarations(child, current, model));
}

function nearestFunctionScope(scope) {
  let current = scope;
  while (!current.functionLike) {
    current = current.parent;
  }
  return current;
}

function declarePattern(pattern, scope, value) {
  for (const identifier of bindingIdentifiers(pattern)) {
    if (!scope.bindings.has(identifier.name)) {
      scope.bindings.set(identifier.name, {
        name: identifier.name,
        declarationStart: identifier.start,
        definite: value.definite,
        initializerStart: value.initializerStart,
        assignmentStarts: [],
      });
    }
  }
}

function collectBindingAssignments(node, scope, scopeByNode) {
  const current = scopeByNode.get(node) ?? scope;
  if (node.type === 'AssignmentExpression') {
    for (const identifier of bindingIdentifiers(node.left)) {
      resolveConstructionBinding(current, identifier.name)?.assignmentStarts.push(node.start);
    }
  }
  forEachChild(node, (child) => collectBindingAssignments(child, current, scopeByNode));
}

function bindingIdentifiers(pattern) {
  if (!isNode(pattern)) {
    return [];
  }
  if (pattern.type === 'Identifier') {
    return [pattern];
  }
  if (pattern.type === 'AssignmentPattern' || pattern.type === 'RestElement') {
    return bindingIdentifiers(pattern.left ?? pattern.argument);
  }
  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.flatMap((property) =>
      bindingIdentifiers(property.type === 'RestElement' ? property.argument : property.value),
    );
  }
  if (pattern.type === 'ArrayPattern') {
    return pattern.elements.flatMap(bindingIdentifiers);
  }
  return pattern.type === 'TSParameterProperty' ? bindingIdentifiers(pattern.parameter) : [];
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

function isRuntimeTypeScriptDeclaration(node) {
  if (node.type === 'TSEnumDeclaration') {
    return true;
  }
  return (
    node.type === 'TSModuleDeclaration' && node.declare !== true && node.id.type === 'Identifier'
  );
}

function isLexicalScope(node) {
  return [
    'BlockStatement',
    'CatchClause',
    'ForInStatement',
    'ForOfStatement',
    'ForStatement',
    'StaticBlock',
    'SwitchStatement',
    'TSModuleBlock',
  ].includes(node.type);
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
