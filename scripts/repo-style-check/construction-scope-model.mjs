class ConstructionScopeModel {
  constructor(scopeByNode, scopes) {
    this.scopeByNode = scopeByNode;
    this.scopes = scopes;
  }
}

export function createConstructionScopeModel(program) {
  const root = {
    parent: undefined,
    bindings: new Map(),
    varScope: true,
    start: program.start,
  };
  const scopeByNode = new WeakMap([[program, root]]);
  const scopes = [root];
  collectScopeDeclarations(program, { scope: root, runtime: true }, { scopeByNode, scopes });
  collectBindingAssignments(program, root, scopeByNode);
  return new ConstructionScopeModel(scopeByNode, scopes);
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

function collectScopeDeclarations(node, scopeTraversal, model) {
  const runtime = scopeTraversal.runtime && node.declare !== true;
  if (runtime) {
    declareFunctionParentBinding(node, scopeTraversal.scope);
  }
  const currentScope = createScopeForNode(node, scopeTraversal.scope, model);
  if (runtime) {
    declareNodeBindings(node, currentScope);
  }
  forEachChild(node, (child) =>
    collectScopeDeclarations(child, { scope: currentScope, runtime }, model),
  );
}

function declareFunctionParentBinding(node, parentScope) {
  if (node.type === 'FunctionDeclaration' && node.id !== null) {
    declarePattern(node.id, parentScope, {
      definite: false,
      initializerStart: parentScope.start,
    });
  }
}

function createScopeForNode(node, parentScope, model) {
  const ownsScope = isFunctionLike(node) || isLexicalScope(node) || node.type === 'ClassExpression';
  if (!ownsScope) {
    model.scopeByNode.set(node, parentScope);
    return parentScope;
  }
  const scope = {
    parent: parentScope,
    bindings: new Map(),
    varScope: isFunctionLike(node) || node.type === 'TSModuleBlock',
    start: node.start,
  };
  model.scopes.push(scope);
  model.scopeByNode.set(node, scope);
  return scope;
}

function declareNodeBindings(node, scope) {
  if (isFunctionLike(node)) {
    for (const parameter of node.params ?? []) {
      declarePattern(parameter, scope, {
        definite: false,
        initializerStart: parameter.start,
      });
    }
    if (node.type === 'FunctionExpression' && node.id !== null) {
      declarePattern(node.id, scope, { definite: false, initializerStart: node.start });
    }
  } else if (node.type === 'VariableDeclaration') {
    const declarationScope = node.kind === 'var' ? nearestVarScope(scope) : scope;
    for (const declaration of node.declarations) {
      declarePattern(declaration.id, declarationScope, {
        definite: declaration.definite === true,
        initializerStart: declaration.init?.start,
      });
    }
  } else if (node.type === 'CatchClause' && node.param !== null) {
    declarePattern(node.param, scope, {
      definite: false,
      initializerStart: node.param.start,
    });
  } else if (node.type === 'ClassDeclaration' && node.id !== null) {
    declarePattern(node.id, scope, { definite: false, initializerStart: node.start });
  } else if (node.type === 'ClassExpression' && node.id !== null) {
    declarePattern(node.id, scope, { definite: false, initializerStart: node.start });
  } else if (isRuntimeTypeScriptDeclaration(node)) {
    declarePattern(node.id, scope, { definite: false, initializerStart: node.start });
  }
}

function nearestVarScope(scope) {
  let current = scope;
  while (!current.varScope) {
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
