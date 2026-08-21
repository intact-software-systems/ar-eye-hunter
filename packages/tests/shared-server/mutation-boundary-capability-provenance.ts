import {
    capabilityExpressionKey,
    isCapabilityFunction,
    readCapabilityMethod,
    readCapabilityPropertyName,
    setCapability,
    setCapabilityMethod,
    type CapabilityBindingAnalysis
} from './mutation-boundary-capability-access.ts';
import {
    asCapabilityNode as asNode,
    asCapabilityNodes as asNodes,
    readCapabilityLiteralString as readLiteralString,
    readCapabilityName as readName,
    type MutationBoundaryCapabilityAstNode as AstNode
} from './mutation-boundary-capability-ast.ts';
import type { CapabilityTypeShape } from './mutation-boundary-capability-types.ts';

export function bindCapabilityNode(
    node: AstNode,
    analysis: CapabilityBindingAnalysis
): boolean {
    if (node.type === 'VariableDeclarator') {
        const id = asNode(node.id);
        const init = asNode(node.init);
        return (
            bindString(id, init, analysis) ||
            bindPattern(id, id?.typeAnnotation, init, analysis)
        );
    }
    if (node.type === 'AssignmentExpression') {
        return bindPattern(
            asNode(node.left),
            undefined,
            asNode(node.right),
            analysis
        );
    }
    if (isCapabilityFunction(node)) {
        return bindFunctionParameters(node, analysis);
    }
    if (
        node.type === 'ClassProperty' ||
        node.type === 'ClassPrivateProperty' ||
        node.type === 'PropertyDefinition'
    ) {
        return bindClassProperty(node, analysis);
    }
    return false;
}

function bindFunctionParameters(
    node: AstNode,
    analysis: CapabilityBindingAnalysis
): boolean {
    let changed = false;
    for (const parameter of asNodes(node.params)) {
        const parameterProperty = parameter.type === 'TSParameterProperty';
        const actual = parameterProperty ? asNode(parameter.parameter) : parameter;
        changed = bindPattern(actual, actual?.typeAnnotation, undefined, analysis) ||
            changed;
        if (
            parameterProperty &&
            node.type === 'ClassMethod' &&
            node.kind === 'constructor' &&
            actual?.type === 'Identifier'
        ) {
            const thisKey = analysis.bindings.thisKey(node);
            const sourceKey = analysis.bindings.identifierKey(actual);
            const targetKey = thisKey ? `${thisKey}.${readName(actual)}` : '';
            changed = copyProvenance(targetKey, sourceKey, analysis) || changed;
        }
    }
    return changed;
}

function bindClassProperty(
    node: AstNode,
    analysis: CapabilityBindingAnalysis
): boolean {
    const name = readCapabilityPropertyName(node.key, false, analysis);
    const thisKey = analysis.bindings.thisKey(node);
    const targetKey = thisKey && name ? `${thisKey}.${name}` : '';
    if (!targetKey) {
        return false;
    }
    const value = asNode(node.value);
    const shape = analysis.resolver.resolveType(node.typeAnnotation) ??
        analysis.values.resolve(value);
    const sourceKey = capabilityExpressionKey(value, analysis);
    let changed = bindValueProvenance(
        targetKey,
        sourceKey,
        shape,
        value,
        analysis
    );
    if (shape) {
        changed = bindShape(targetKey, shape, analysis) || changed;
    }
    return changed;
}

function bindPattern(
    pattern: AstNode | undefined,
    typeAnnotation: unknown,
    value: AstNode | undefined,
    analysis: CapabilityBindingAnalysis
): boolean {
    if (!pattern) {
        return false;
    }
    if (
        pattern.type === 'MemberExpression' ||
        pattern.type === 'OptionalMemberExpression'
    ) {
        return bindValueProvenance(
            capabilityExpressionKey(pattern, analysis),
            capabilityExpressionKey(value, analysis),
            analysis.values.resolve(value),
            value,
            analysis
        );
    }
    if (pattern.type === 'Identifier') {
        const targetKey = analysis.bindings.identifierKey(pattern);
        const sourceKey = capabilityExpressionKey(value, analysis);
        const shape = analysis.resolver.resolveType(typeAnnotation) ??
            analysis.values.resolve(value);
        let changed = bindValueProvenance(
            targetKey,
            sourceKey,
            shape,
            value,
            analysis
        );
        if (value?.type === 'ObjectExpression') {
            changed = bindObjectExpression(targetKey, value, analysis) || changed;
        }
        return changed;
    }
    if (pattern.type === 'AssignmentPattern') {
        return bindPattern(
            asNode(pattern.left),
            asNode(pattern.left)?.typeAnnotation ?? typeAnnotation,
            asNode(pattern.right),
            analysis
        );
    }
    if (pattern.type === 'ArrayPattern') {
        const shape = analysis.resolver.resolveType(typeAnnotation) ??
            analysis.values.resolve(value);
        return bindArrayPattern(
            pattern,
            shape,
            capabilityExpressionKey(value, analysis),
            analysis
        );
    }
    if (pattern.type !== 'ObjectPattern') {
        return false;
    }
    const shape = analysis.resolver.resolveType(typeAnnotation) ??
        analysis.values.resolve(value);
    return bindObjectPattern(
        pattern,
        shape,
        capabilityExpressionKey(value, analysis),
        analysis
    );
}

function bindArrayPattern(
    pattern: AstNode,
    shape: CapabilityTypeShape | undefined,
    sourceKey: string,
    analysis: CapabilityBindingAnalysis
): boolean {
    let changed = false;
    const elements = Array.isArray(pattern.elements) ? pattern.elements : [];
    for (const [index, rawTarget] of elements.entries()) {
        const item = asNode(rawTarget);
        const target = item?.type === 'AssignmentPattern' ? asNode(item.left) : item;
        if (!target) {
            continue;
        }
        const name = String(index);
        const memberShape = shape?.members?.get(name);
        const memberSource = sourceKey ? `${sourceKey}.${name}` : '';
        if (target.type === 'Identifier') {
            changed = bindValueProvenance(
                analysis.bindings.identifierKey(target),
                memberSource,
                memberShape,
                undefined,
                analysis
            ) || changed;
        }
        else if (target.type === 'ArrayPattern') {
            changed = bindArrayPattern(target, memberShape, memberSource, analysis) ||
                changed;
        }
        else if (target.type === 'ObjectPattern') {
            changed = bindObjectPattern(target, memberShape, memberSource, analysis) ||
                changed;
        }
    }
    return changed;
}

function bindValueProvenance(
    targetKey: string,
    sourceKey: string,
    shape: CapabilityTypeShape | undefined,
    value: AstNode | undefined,
    analysis: CapabilityBindingAnalysis
): boolean {
    if (!targetKey) {
        return false;
    }
    const capability = shape?.capability ?? analysis.receivers.get(sourceKey);
    let changed = shape ? setShape(analysis.shapes, targetKey, shape) : false;
    changed = capability
        ? setCapability(analysis.receivers, targetKey, capability) || changed
        : changed;
    if (shape) {
        changed = bindShape(targetKey, shape, analysis) || changed;
    }
    const method = readCapabilityMethod(value, analysis) ?? analysis.methods.get(sourceKey);
    if (method) {
        changed = setCapabilityMethod(analysis.methods, targetKey, method) || changed;
    }
    return changed;
}

function setShape(
    shapes: Map<string, CapabilityTypeShape>,
    key: string,
    shape: CapabilityTypeShape
): boolean {
    if (!key || shapes.has(key)) {
        return false;
    }
    shapes.set(key, shape);
    return true;
}

function bindObjectExpression(
    targetKey: string,
    value: AstNode,
    analysis: CapabilityBindingAnalysis
): boolean {
    let changed = false;
    for (const property of asNodes(value.properties)) {
        const name = readCapabilityPropertyName(
            property.key,
            property.computed === true,
            analysis
        );
        const memberValue = asNode(property.value);
        if (!name || !memberValue) {
            continue;
        }
        changed = bindValueProvenance(
            `${targetKey}.${name}`,
            capabilityExpressionKey(memberValue, analysis),
            analysis.values.resolve(memberValue),
            memberValue,
            analysis
        ) || changed;
    }
    return changed;
}

function bindObjectPattern(
    pattern: AstNode,
    shape: CapabilityTypeShape | undefined,
    sourceKey: string,
    analysis: CapabilityBindingAnalysis
): boolean {
    const sourceCapability = analysis.receivers.get(sourceKey) ?? shape?.capability;
    let changed = false;
    for (const property of asNodes(pattern.properties)) {
        if (property.type !== 'ObjectProperty') {
            continue;
        }
        const name = readCapabilityPropertyName(
            property.key,
            property.computed === true,
            analysis
        );
        const rawTarget = asNode(property.value);
        const target = rawTarget?.type === 'AssignmentPattern' ? asNode(rawTarget.left) : rawTarget;
        const memberShape = shape?.members?.get(name);
        const memberSource = sourceKey ? `${sourceKey}.${name}` : '';
        if (target?.type === 'Identifier') {
            const targetKey = analysis.bindings.identifierKey(target);
            changed = bindValueProvenance(
                targetKey,
                memberSource,
                memberShape,
                undefined,
                analysis
            ) || changed;
            const method = analysis.methods.get(memberSource) ??
                (sourceCapability ? { capability: sourceCapability, method: name } : undefined);
            if (method) {
                changed = setCapabilityMethod(analysis.methods, targetKey, method) || changed;
            }
        }
        else if (target?.type === 'ObjectPattern') {
            changed = bindObjectPattern(target, memberShape, memberSource, analysis) ||
                changed;
        }
    }
    return changed;
}

function bindShape(
    targetKey: string,
    shape: CapabilityTypeShape,
    analysis: CapabilityBindingAnalysis
): boolean {
    let changed = shape.capability
        ? setCapability(analysis.receivers, targetKey, shape.capability)
        : false;
    for (const [name, member] of shape.members ?? []) {
        changed = bindShape(`${targetKey}.${name}`, member, analysis) || changed;
    }
    return changed;
}

function copyProvenance(
    targetKey: string,
    sourceKey: string,
    analysis: CapabilityBindingAnalysis
): boolean {
    if (!targetKey || !sourceKey) {
        return false;
    }
    let changed = false;
    const capability = analysis.receivers.get(sourceKey);
    if (capability) {
        changed = setCapability(analysis.receivers, targetKey, capability);
    }
    const method = analysis.methods.get(sourceKey);
    return method ? setCapabilityMethod(analysis.methods, targetKey, method) || changed : changed;
}

function bindString(
    pattern: AstNode | undefined,
    value: AstNode | undefined,
    analysis: CapabilityBindingAnalysis
): boolean {
    if (pattern?.type !== 'Identifier') {
        return false;
    }
    const literal = readLiteralString(value) ||
        analysis.strings.get(capabilityExpressionKey(value, analysis)) ||
        '';
    return literal
        ? setCapability(
            analysis.strings,
            analysis.bindings.identifierKey(pattern),
            literal
        )
        : false;
}
