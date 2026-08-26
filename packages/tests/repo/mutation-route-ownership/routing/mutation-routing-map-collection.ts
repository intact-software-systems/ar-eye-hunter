import type { MutationBoundaryLexicalValues } from '../boundary/lexical/mutation-boundary-lexical-values.ts';
import { readExactStaticString } from '../execution/mutation-static-semantics.ts';
import type { MutationRoutingAstNode as AstNode } from './mutation-routing-call-graph.ts';
import { isProvenGlobalBuiltin } from './mutation-routing-lexical-evaluation.ts';
import { knownRegistrationTypes, UNKNOWN_REGISTRATION_TYPES, type RegistrationTypeCollection } from './mutation-routing-registration-predicate.ts';

type RegistrationCollectionEvaluator = (
    value: AstNode | undefined
) => RegistrationTypeCollection;

interface MapEntry {
    readonly key: RegistrationTypeCollection;
    readonly value: RegistrationTypeCollection;
}

type MapAlternative = ReadonlyMap<string, MapEntry>;

export function evaluateMapProjection(
    method: string,
    source: AstNode | undefined,
    lexical: MutationBoundaryLexicalValues,
    evaluate: RegistrationCollectionEvaluator
): RegistrationTypeCollection | undefined {
    if (!['keys', 'values', 'entries'].includes(method)) {
        return undefined;
    }
    const alternatives = resolveMap(source, lexical, evaluate, new Set());
    if (alternatives === undefined) {
        return undefined;
    }
    if (alternatives === null || method === 'entries') {
        return UNKNOWN_REGISTRATION_TYPES;
    }
    return projectAlternatives(alternatives, method === 'keys' ? 0 : 1);
}

export function evaluateMapEntriesProjection(
    source: AstNode | undefined,
    callback: AstNode | undefined,
    lexical: MutationBoundaryLexicalValues,
    evaluate: RegistrationCollectionEvaluator
): RegistrationTypeCollection | undefined {
    const entriesCall = readSpreadEntriesCall(source);
    if (!entriesCall) {
        return undefined;
    }
    const callee = asNode(entriesCall.callee);
    const alternatives = resolveMap(
        asNode(callee?.object),
        lexical,
        evaluate,
        new Set()
    );
    if (alternatives === undefined) {
        return undefined;
    }
    const projection = readEntryProjection(callback);
    if (alternatives === null || projection === undefined) {
        return UNKNOWN_REGISTRATION_TYPES;
    }
    return projectAlternatives(alternatives, projection);
}

export function readStaticCollectionMethod(
    callee: AstNode | undefined,
    lexical: MutationBoundaryLexicalValues
): string {
    if (
        callee?.type !== 'MemberExpression' &&
        callee?.type !== 'OptionalMemberExpression'
    ) {
        return '';
    }
    if (callee.computed !== true) {
        return readName(callee.property);
    }
    return resolveStaticString(asNode(callee.property), lexical, new Set());
}

function resolveMap(
    value: AstNode | undefined,
    lexical: MutationBoundaryLexicalValues,
    evaluate: RegistrationCollectionEvaluator,
    resolving: Set<string>
): readonly MapAlternative[] | null | undefined {
    const node = unwrap(value);
    if (node?.type === 'Identifier') {
        const key = lexical.bindings.identifierKey(node);
        if (resolving.has(key)) {
            return null;
        }
        const resolved = lexical.resolveIdentifier(node);
        if (resolved.unknown || resolved.values.length !== 1) {
            return undefined;
        }
        return resolveMap(
            resolved.values[0],
            lexical,
            evaluate,
            new Set(resolving).add(key)
        );
    }
    if (node?.type === 'ConditionalExpression') {
        const left = resolveMap(
            asNode(node.consequent),
            lexical,
            evaluate,
            resolving
        );
        const right = resolveMap(
            asNode(node.alternate),
            lexical,
            evaluate,
            resolving
        );
        if (left === undefined || right === undefined) {
            return undefined;
        }
        if (left === null || right === null) {
            return null;
        }
        return [...left, ...right];
    }
    if (
        node?.type !== 'NewExpression' ||
        !isProvenGlobalBuiltin(asNode(node.callee), 'Map', lexical)
    ) {
        return undefined;
    }
    return resolveEntryAlternatives(
        asNodes(node.arguments)[0],
        lexical,
        evaluate,
        resolving
    );
}

function resolveEntryAlternatives(
    value: AstNode | undefined,
    lexical: MutationBoundaryLexicalValues,
    evaluate: RegistrationCollectionEvaluator,
    resolving: Set<string>
): readonly MapAlternative[] | null {
    const node = unwrap(value);
    if (node?.type === 'Identifier') {
        const key = lexical.bindings.identifierKey(node);
        if (resolving.has(key)) {
            return null;
        }
        const resolved = lexical.resolveIdentifier(node);
        return !resolved.unknown && resolved.values.length === 1
            ? resolveEntryAlternatives(
                resolved.values[0],
                lexical,
                evaluate,
                new Set(resolving).add(key)
            )
            : null;
    }
    if (node?.type === 'ConditionalExpression') {
        const test = unwrap(asNode(node.test));
        if (test?.type === 'BooleanLiteral') {
            return resolveEntryAlternatives(
                asNode(test.value === true ? node.consequent : node.alternate),
                lexical,
                evaluate,
                resolving
            );
        }
        const left = resolveEntryAlternatives(
            asNode(node.consequent),
            lexical,
            evaluate,
            resolving
        );
        const right = resolveEntryAlternatives(
            asNode(node.alternate),
            lexical,
            evaluate,
            resolving
        );
        return left === null || right === null ? null : [...left, ...right];
    }
    if (node?.type !== 'ArrayExpression' && node?.type !== 'TupleExpression') {
        return null;
    }
    const entries = new Map<string, MapEntry>();
    for (const candidate of asNodes(node.elements)) {
        const tuple = unwrap(candidate);
        if (
            tuple?.type !== 'ArrayExpression' &&
            tuple?.type !== 'TupleExpression'
        ) {
            return null;
        }
        const [keyNode, valueNode] = asNodes(tuple.elements);
        const key = evaluate(keyNode);
        const keyName = key.kind === 'known' && key.types.size === 1 ? [...key.types][0] : '';
        if (!keyName || !valueNode) {
            return null;
        }
        entries.set(keyName, { key, value: evaluate(valueNode) });
    }
    return [entries];
}

function projectAlternatives(
    alternatives: readonly MapAlternative[],
    projection: 0 | 1
): RegistrationTypeCollection {
    if (alternatives.length === 0) {
        return knownRegistrationTypes([]);
    }
    const projected = alternatives.map((alternative) => {
        const types = new Set<string>();
        for (const entry of alternative.values()) {
            const collection = projection === 0 ? entry.key : entry.value;
            if (collection.kind === 'unknown') {
                return undefined;
            }
            for (const type of collection.types) {
                types.add(type);
            }
        }
        return types;
    });
    if (projected.some((types) => types === undefined)) {
        return UNKNOWN_REGISTRATION_TYPES;
    }
    const guaranteed = new Set(projected[0]);
    for (const types of projected.slice(1)) {
        for (const type of guaranteed) {
            if (!types!.has(type)) {
                guaranteed.delete(type);
            }
        }
    }
    return knownRegistrationTypes(guaranteed);
}

function readSpreadEntriesCall(
    value: AstNode | undefined
): AstNode | undefined {
    const node = unwrap(value);
    if (node?.type !== 'ArrayExpression') {
        return undefined;
    }
    const elements = asNodes(node.elements);
    if (elements.length !== 1 || elements[0]?.type !== 'SpreadElement') {
        return undefined;
    }
    const call = unwrap(asNode(elements[0].argument));
    if (
        call?.type !== 'CallExpression' &&
        call?.type !== 'OptionalCallExpression'
    ) {
        return undefined;
    }
    const callee = asNode(call.callee);
    return readName(callee?.property) === 'entries' ? call : undefined;
}

function readEntryProjection(callback: AstNode | undefined): 0 | 1 | undefined {
    if (
        callback?.type !== 'ArrowFunctionExpression' &&
        callback?.type !== 'FunctionExpression'
    ) {
        return undefined;
    }
    const parameter = asNodes(callback.params)[0];
    const body = readCallbackBody(asNode(callback.body));
    if (!parameter || !body) {
        return undefined;
    }
    if (parameter.type === 'ArrayPattern' && body.type === 'Identifier') {
        const elements = Array.isArray(parameter.elements) ? parameter.elements : [];
        if (readName(elements[0]) === readName(body)) {
            return 0;
        }
        if (readName(elements[1]) === readName(body)) {
            return 1;
        }
    }
    if (
        parameter.type === 'Identifier' &&
        body.type === 'MemberExpression' &&
        readName(body.object) === readName(parameter) &&
        body.computed === true
    ) {
        const index = readNumber(body.property);
        return index === 0 || index === 1 ? index : undefined;
    }
    return undefined;
}

function readCallbackBody(value: AstNode | undefined): AstNode | undefined {
    const body = unwrap(value);
    if (body?.type !== 'BlockStatement') {
        return body;
    }
    const statements = asNodes(body.body);
    return statements.length === 1 && statements[0]?.type === 'ReturnStatement'
        ? unwrap(asNode(statements[0].argument))
        : undefined;
}

function resolveStaticString(
    value: AstNode | undefined,
    lexical: MutationBoundaryLexicalValues,
    _resolving: Set<string>
): string {
    return readExactStaticString(value, lexical);
}

function unwrap(value: AstNode | undefined): AstNode | undefined {
    if (
        value?.type === 'TSAsExpression' ||
        value?.type === 'TSTypeAssertion' ||
        value?.type === 'TypeCastExpression' ||
        value?.type === 'TSNonNullExpression' ||
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

function readNumber(value: unknown): number | undefined {
    const node = asNode(value);
    return node?.type === 'NumericLiteral' && typeof node.value === 'number' ? node.value : undefined;
}

function asNode(value: unknown): AstNode | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as AstNode)
        : undefined;
}

function asNodes(value: unknown): readonly AstNode[] {
    return Array.isArray(value)
        ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
        : [];
}
