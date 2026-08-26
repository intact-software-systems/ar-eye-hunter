import {
    absentArgumentSlot,
    argumentSlotUsesDefault,
    exactArgumentSlot,
    mergeArgumentSlots,
    undefinedArgumentSlot,
    unknownArgumentSlot,
    type ArgumentSlot
} from '../boundary/callables/mutation-argument-slots.ts';
import {
    mutationBoundaryLexicalValuesEqual,
    type LexicalValueResolution,
    type MutationBoundaryLexicalValues
} from '../boundary/lexical/mutation-boundary-lexical-values.ts';
import { evaluateStaticTruth, readExactStaticString, resolveStaticValues } from '../execution/mutation-static-semantics.ts';
import { findAstNode, type MutationRoutingAstNode as AstNode } from './mutation-routing-call-graph.ts';
import { collectRoutingExecutionPaths, withRoutingLexicalOverrides, type RoutingExecutionPath } from './mutation-routing-execution-paths.ts';

type RoutingArgumentSlot = ArgumentSlot<AstNode>;

interface CallableReference {
    readonly boundSlots: readonly RoutingArgumentSlot[];
}

export function readInvocationLexicalPaths(
    program: AstNode,
    loop: AstNode,
    lexical: MutationBoundaryLexicalValues
): readonly (readonly MutationBoundaryLexicalValues[])[] {
    let callable: AstNode | undefined;
    visit(program, (node) => {
        if (isLocalFunction(node) && containsNode(node, loop)) {
            callable = node;
        }
    });
    if (!callable) {
        return [[lexical]];
    }
    const expected = callable;
    const owner = findCallableOwner(program, expected);
    const paths = collectRoutingExecutionPaths<MutationBoundaryLexicalValues>(
        asNode(owner.body) ?? owner,
        lexical,
        (call, path) => appendInvocation(call, path, expected),
        mutationBoundaryLexicalValuesEqual
    );
    return paths.map((path) => path.values);
}

function appendInvocation(
    call: AstNode,
    path: RoutingExecutionPath<MutationBoundaryLexicalValues>,
    callable: AstNode
): RoutingExecutionPath<MutationBoundaryLexicalValues> {
    const family = readCallFamily(call, path.lexical);
    if (family === 'bind') {
        return path;
    }
    const callee = unwrap(asNode(call.callee));
    const target = family === 'call' || family === 'apply' ? asNode(callee?.object) : callee;
    const references = resolveCallableReferences(target, callable, path.lexical, new Set());
    if (references.length === 0) {
        return path;
    }
    const slots = resolveCallSlots(call, family, path.lexical);
    const invocations = references.map((reference) => invocationLexical(callable, [...reference.boundSlots, ...slots], path.lexical));
    return { ...path, values: [...path.values, ...invocations] };
}

function resolveCallableReferences(
    value: AstNode | undefined,
    expected: AstNode,
    lexical: MutationBoundaryLexicalValues,
    resolving: Set<string>
): readonly CallableReference[] {
    const node = unwrap(value);
    if (node === expected || matchesFunctionIdentifier(node, expected, lexical)) {
        return [{ boundSlots: [] }];
    }
    if (node?.type === 'CallExpression' || node?.type === 'OptionalCallExpression') {
        if (readCallFamily(node, lexical) !== 'bind') {
            return [];
        }
        const callee = asNode(node.callee);
        const targets = resolveCallableReferences(asNode(callee?.object), expected, lexical, resolving);
        const slots = resolveCallSlots(node, 'bind', lexical);
        return targets.map((target) => ({ boundSlots: [...target.boundSlots, ...slots] }));
    }
    if (node?.type !== 'Identifier') {
        return [];
    }
    const key = lexical.bindings.identifierKey(node);
    if (!key || resolving.has(key)) {
        return [];
    }
    const resolved = lexical.resolveIdentifier(node);
    if (resolved.unknown || resolved.values.length === 0) {
        return [];
    }
    return resolved.values.flatMap((candidate) => resolveCallableReferences(candidate, expected, lexical, new Set(resolving).add(key)));
}

function invocationLexical(
    callable: AstNode,
    slots: readonly RoutingArgumentSlot[],
    lexical: MutationBoundaryLexicalValues
): MutationBoundaryLexicalValues {
    const overrides = new Map<string, LexicalValueResolution>();
    for (const [index, rawParameter] of asNodes(callable.params).entries()) {
        const parameter = unwrapParameter(rawParameter);
        if (parameter?.type !== 'Identifier') {
            continue;
        }
        const slot = slots[index];
        const values = [...(slot?.values ?? [])];
        if (argumentSlotUsesDefault(slot) && rawParameter.type === 'AssignmentPattern') {
            const fallback = asNode(rawParameter.right);
            if (fallback) {
                values.push(fallback);
            }
        }
        overrides.set(lexical.bindings.identifierKey(parameter), {
            values: [...new Set(values)],
            unknown: slot?.unknown === true || values.length === 0
        });
    }
    return withRoutingLexicalOverrides(lexical, overrides);
}

function resolveCallSlots(
    call: AstNode,
    family: 'apply' | 'bind' | 'call' | 'direct',
    lexical: MutationBoundaryLexicalValues
): readonly RoutingArgumentSlot[] {
    const arguments_ = rawNodes(call.arguments);
    if (family === 'apply') {
        return resolveArgumentSequence(arguments_[1], lexical, new Set());
    }
    const values = family === 'call' || family === 'bind' ? arguments_.slice(1) : arguments_;
    return resolveDirectSlots(values, lexical);
}

function resolveDirectSlots(
    values: readonly (AstNode | undefined)[],
    lexical: MutationBoundaryLexicalValues
): readonly RoutingArgumentSlot[] {
    return values.flatMap((value) =>
        value?.type === 'SpreadElement'
            ? resolveArgumentSequence(asNode(value.argument), lexical, new Set())
            : [resolveArgumentValue(value, lexical)]
    );
}

function resolveArgumentSequence(
    value: AstNode | undefined,
    lexical: MutationBoundaryLexicalValues,
    resolving: Set<string>
): readonly RoutingArgumentSlot[] {
    const node = unwrap(value);
    if (!node) {
        return [unknownArgumentSlot()];
    }
    if (node.type === 'ArrayExpression' || node.type === 'TupleExpression') {
        return resolveDirectSlots(rawNodes(node.elements), lexical);
    }
    if (node.type === 'Identifier') {
        const key = lexical.bindings.identifierKey(node);
        if (!key || resolving.has(key)) {
            return [unknownArgumentSlot()];
        }
        const resolved = lexical.resolveIdentifier(node);
        if (resolved.values.length === 0) {
            return [unknownArgumentSlot()];
        }
        const alternatives = resolved.values.map((candidate) => resolveArgumentSequence(candidate, lexical, new Set(resolving).add(key)));
        return mergeSlotSequences(alternatives, resolved.unknown);
    }
    if (node.type === 'ConditionalExpression') {
        const truth = evaluateStaticTruth(node.test, lexical);
        if (truth !== undefined) {
            return resolveArgumentSequence(
                asNode(truth ? node.consequent : node.alternate),
                lexical,
                resolving
            );
        }
        return mergeSlotSequences([
            resolveArgumentSequence(asNode(node.consequent), lexical, new Set(resolving)),
            resolveArgumentSequence(asNode(node.alternate), lexical, new Set(resolving))
        ]);
    }
    return [unknownArgumentSlot()];
}

function mergeSlotSequences(
    sequences: readonly (readonly RoutingArgumentSlot[])[],
    unknown = false
): readonly RoutingArgumentSlot[] {
    const length = Math.max(0, ...sequences.map((sequence) => sequence.length));
    return Array.from({ length }, (_, index) => {
        const merged = mergeArgumentSlots(
            sequences.map((sequence) => sequence[index] ?? absentArgumentSlot())
        );
        return unknown ? { ...merged, unknown: true } : merged;
    });
}

function resolveArgumentValue(
    value: AstNode | undefined,
    lexical: MutationBoundaryLexicalValues
): RoutingArgumentSlot {
    if (!value) {
        return absentArgumentSlot();
    }
    const resolved = resolveStaticValues(value, lexical);
    if (
        resolved.values.size === 1 && [...resolved.values][0] === undefined &&
        !resolved.unknownFalsy && !resolved.unknownTruthy
    ) {
        return undefinedArgumentSlot();
    }
    return exactArgumentSlot(value);
}

function readCallFamily(
    call: AstNode,
    lexical: MutationBoundaryLexicalValues
): 'apply' | 'bind' | 'call' | 'direct' {
    const callee = unwrap(asNode(call.callee));
    if (callee?.type !== 'MemberExpression' && callee?.type !== 'OptionalMemberExpression') {
        return 'direct';
    }
    const method = callee.computed === true
        ? readExactStaticString(callee.property, lexical)
        : readName(callee.property);
    return method === 'apply' || method === 'bind' || method === 'call' ? method : 'direct';
}

function findCallableOwner(program: AstNode, callable: AstNode): AstNode {
    let owner = program;
    visit(program, (node) => {
        if (node !== callable && isFunction(node) && containsNode(node, callable)) {
            owner = node;
        }
    });
    return owner;
}

function matchesFunctionIdentifier(
    value: AstNode | undefined,
    expected: AstNode,
    lexical: MutationBoundaryLexicalValues
): boolean {
    const expectedId = asNode(expected.id);
    return value?.type === 'Identifier' && expectedId?.type === 'Identifier' &&
        lexical.bindings.identifierKey(value) === lexical.bindings.identifierKey(expectedId);
}

function unwrapParameter(parameter: AstNode): AstNode | undefined {
    if (parameter.type === 'AssignmentPattern') {
        return asNode(parameter.left);
    }
    if (parameter.type === 'RestElement') {
        return asNode(parameter.argument);
    }
    return parameter;
}

function containsNode(value: unknown, expected: AstNode): boolean {
    return findAstNode(value, (node) => node === expected) !== undefined;
}

function isLocalFunction(node: AstNode): boolean {
    return ['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(
        node.type
    );
}

function isFunction(node: AstNode): boolean {
    return isLocalFunction(node) || [
        'ObjectMethod',
        'ClassMethod',
        'ClassPrivateMethod'
    ].includes(node.type);
}

function visit(value: unknown, visitor: (node: AstNode) => void): void {
    if (!value || typeof value !== 'object') {
        return;
    }
    if (Array.isArray(value)) {
        for (const child of value) {
            visit(child, visitor);
        }
        return;
    }
    const node = value as AstNode;
    if (typeof node.type === 'string') {
        visitor(node);
    }
    for (const [key, child] of Object.entries(node)) {
        if (!IGNORED_KEYS.has(key)) {
            visit(child, visitor);
        }
    }
}

function unwrap(value: AstNode | undefined): AstNode | undefined {
    if (
        value?.type === 'TSAsExpression' || value?.type === 'TSTypeAssertion' ||
        value?.type === 'TypeCastExpression' || value?.type === 'TSNonNullExpression' ||
        value?.type === 'ParenthesizedExpression'
    ) {
        return unwrap(asNode(value.expression));
    }
    return value;
}

function readName(value: unknown): string {
    const node = asNode(value);
    return node && typeof node.name === 'string' ? node.name : '';
}

function rawNodes(value: unknown): readonly (AstNode | undefined)[] {
    return Array.isArray(value) ? value.map(asNode) : [];
}

function asNode(value: unknown): AstNode | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
}

function asNodes(value: unknown): readonly AstNode[] {
    return Array.isArray(value)
        ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
        : [];
}

const IGNORED_KEYS = new Set(['loc', 'start', 'end', 'comments', 'tokens']);
