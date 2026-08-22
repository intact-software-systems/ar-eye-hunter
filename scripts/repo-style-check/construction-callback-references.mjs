const transparentExpressionTypes = new Set([
    'ParenthesizedExpression',
    'TSAsExpression',
    'TSInstantiationExpression',
    'TSNonNullExpression',
    'TSSatisfiesExpression',
    'TSTypeAssertion',
    'TypeCastExpression'
]);

export function findConstructionCallbacks(argument) {
    return findCallbackValues(argument);
}

export function collectConstructionCallbackReferences(callback) {
    const references = [];
    forEachChild(callback, (child, key) =>
        collectReferences({
            node: child,
            parent: callback,
            key,
            references
        }));
    return references;
}

function findCallbackValues(value) {
    const node = unwrapExpression(value);
    if (!isNode(node)) {
        return [];
    }
    if (isFunctionLike(node)) {
        return [node];
    }
    if (node.type === 'ConditionalExpression') {
        return [...findCallbackValues(node.consequent), ...findCallbackValues(node.alternate)];
    }
    if (node.type === 'LogicalExpression') {
        return [...findCallbackValues(node.left), ...findCallbackValues(node.right)];
    }
    if (node.type === 'ObjectExpression') {
        return node.properties.flatMap(findObjectPropertyCallbacks);
    }
    return [];
}

function findObjectPropertyCallbacks(property) {
    if (property.type === 'ObjectMethod') {
        return [property];
    }
    if (property.type === 'ObjectProperty') {
        return findCallbackValues(property.value);
    }
    if (property.type !== 'SpreadElement') {
        return [];
    }
    return findSpreadObjectCallbacks(property.argument);
}

function findSpreadObjectCallbacks(value) {
    const node = unwrapExpression(value);
    if (node?.type === 'ObjectExpression') {
        return findCallbackValues(node);
    }
    if (node?.type === 'ConditionalExpression') {
        return [
            ...findSpreadObjectCallbacks(node.consequent),
            ...findSpreadObjectCallbacks(node.alternate)
        ];
    }
    if (node?.type === 'LogicalExpression') {
        return [...findSpreadObjectCallbacks(node.left), ...findSpreadObjectCallbacks(node.right)];
    }
    return [];
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
    if (isRuntimeReference(input.node, input.parent, input.key)) {
        input.references.push(input.node);
    }
    forEachChild(input.node, (child, key) =>
        collectReferences({
            ...input,
            node: child,
            parent: input.node,
            key
        }));
}

function isRuntimeReference(node, parent, key) {
    if (node.type === 'Identifier') {
        return isReferenceIdentifier(parent, key);
    }
    return node.type === 'JSXIdentifier' && isReferenceJsxIdentifier(node, parent, key);
}

function isReferenceIdentifier(parent, key) {
    const member = parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression';
    const propertyKey = isPropertyKeyParent(parent) && key === 'key';
    return !(
        (parent.type === 'VariableDeclarator' && key === 'id') ||
        (isFunctionLike(parent) && (key === 'id' || key === 'params')) ||
        (member && key === 'property' && !parent.computed) ||
        (propertyKey && !parent.computed) ||
        parent.type === 'MetaProperty' ||
        parent.type === 'PrivateName' ||
        (isLabelReferenceParent(parent) && key === 'label') ||
        ['ImportSpecifier', 'ExportSpecifier', 'LabeledStatement'].includes(parent.type)
    );
}

function isReferenceJsxIdentifier(node, parent, key) {
    const directTag = ['JSXOpeningElement', 'JSXClosingElement'].includes(parent.type) && key === 'name';
    if (directTag) {
        return /^[A-Z]/u.test(node.name);
    }
    return parent.type === 'JSXMemberExpression' && key === 'object';
}

function isPropertyKeyParent(parent) {
    return [
        'ObjectProperty',
        'ObjectMethod',
        'ClassProperty',
        'ClassPrivateProperty',
        'ClassAccessorProperty',
        'ClassMethod',
        'ClassPrivateMethod'
    ].includes(parent.type);
}

function isLabelReferenceParent(parent) {
    return parent.type === 'BreakStatement' || parent.type === 'ContinueStatement';
}

function unwrapExpression(node) {
    let current = node;
    while (isNode(current) && transparentExpressionTypes.has(current.type)) {
        current = current.expression;
    }
    return current;
}

function isFunctionLike(node) {
    return [
        'FunctionDeclaration',
        'FunctionExpression',
        'ArrowFunctionExpression',
        'ObjectMethod',
        'ClassMethod',
        'ClassPrivateMethod'
    ].includes(node.type);
}

function forEachChild(node, visit) {
    for (const [key, value] of Object.entries(node)) {
        if (['loc', 'extra', 'tokens', 'comments'].includes(key)) {
            continue;
        }
        if (Array.isArray(value)) {
            value.filter(isNode).forEach((child) => visit(child, key));
        }
        else if (isNode(value)) {
            visit(value, key);
        }
    }
}

function isNode(value) {
    return value !== null && typeof value === 'object' && typeof value.type === 'string';
}
