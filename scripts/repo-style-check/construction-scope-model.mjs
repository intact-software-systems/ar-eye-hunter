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
      valueSource: createValueSource(parentScope.start, parentScope.start),
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
        valueSource: createValueSource(parameter.start, parameter.start),
      });
    }
    if (node.type === 'FunctionExpression' && node.id !== null) {
      declarePattern(node.id, scope, {
        definite: false,
        valueSource: createValueSource(node.start, node.start),
      });
    }
  } else if (node.type === 'VariableDeclaration') {
    const declarationScope = node.kind === 'var' ? nearestVarScope(scope) : scope;
    for (const declaration of node.declarations) {
      declarePattern(declaration.id, declarationScope, {
        definite: declaration.definite === true,
        valueSource:
          declaration.init === null
            ? undefined
            : createValueSource(declaration.init.start, declaration.init.end),
      });
    }
  } else if (node.type === 'CatchClause' && node.param !== null) {
    declarePattern(node.param, scope, {
      definite: false,
      valueSource: createValueSource(node.param.start, node.param.start),
    });
  } else if (node.type === 'ClassDeclaration' && node.id !== null) {
    declarePattern(node.id, scope, {
      definite: false,
      valueSource: createValueSource(node.start, node.start),
    });
  } else if (node.type === 'ClassExpression' && node.id !== null) {
    declarePattern(node.id, scope, {
      definite: false,
      valueSource: createValueSource(node.start, node.start),
    });
  } else if (isRuntimeTypeScriptDeclaration(node)) {
    declarePattern(node.id, scope, {
      definite: false,
      valueSource: createValueSource(node.start, node.start),
    });
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
    const existing = scope.bindings.get(identifier.name);
    if (existing === undefined) {
      const binding = {
        name: identifier.name,
        declarationStart: identifier.start,
        definite: value.definite,
        valueSources: [],
      };
      addValueSource(binding, value.valueSource);
      scope.bindings.set(identifier.name, binding);
    } else {
      existing.definite ||= value.definite;
      addValueSource(existing, value.valueSource);
    }
  }
}

function collectBindingAssignments(node, scope, scopeByNode) {
  const current = scopeByNode.get(node) ?? scope;
  if (node.type === 'AssignmentExpression') {
    addAssignmentSources(
      bindingIdentifiers(node.left),
      current,
      createValueSource(node.start, node.right.end),
    );
  } else if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
    const targets =
      node.left.type === 'VariableDeclaration'
        ? node.left.declarations.flatMap((declaration) => bindingIdentifiers(declaration.id))
        : bindingIdentifiers(node.left);
    addAssignmentSources(targets, current, createValueSource(node.left.start, node.right.end));
  }
  forEachChild(node, (child) => collectBindingAssignments(child, current, scopeByNode));
}

function addAssignmentSources(identifiers, scope, valueSource) {
  for (const identifier of identifiers) {
    addValueSource(resolveConstructionBinding(scope, identifier.name), valueSource);
  }
}

function addValueSource(binding, valueSource) {
  if (binding !== undefined && valueSource !== undefined) {
    binding.valueSources.push(valueSource);
  }
}

function createValueSource(sourceStart, availableAfter) {
  return { sourceStart, availableAfter };
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
