import type { MutationRoutingAstNode as AstNode } from './mutation-routing-call-graph.ts';
import {
    knownRegistrationTypes,
    UNKNOWN_REGISTRATION_TYPES,
    unknownRegistrationTypes,
    type RegistrationTypeCollection
} from './mutation-routing-registration-predicate.ts';

type RegistrationCollectionEvaluator = (
    value: AstNode | undefined
) => RegistrationTypeCollection;

export function evaluateStaticObjectCollection(
    method: string,
    source: AstNode | undefined,
    evaluate: RegistrationCollectionEvaluator
): RegistrationTypeCollection {
    if (method === 'entries') {
        return UNKNOWN_REGISTRATION_TYPES;
    }
    if (method !== 'keys' && method !== 'values') {
        return UNKNOWN_REGISTRATION_TYPES;
    }
    return evaluateObjectProjection(source, method === 'keys' ? 0 : 1, evaluate);
}

export function evaluateObjectEntriesMap(
    source: AstNode | undefined,
    callback: AstNode | undefined,
    evaluate: RegistrationCollectionEvaluator
): RegistrationTypeCollection {
    const projection = readEntryProjection(callback);
    return projection === undefined
        ? UNKNOWN_REGISTRATION_TYPES
        : evaluateObjectProjection(source, projection, evaluate);
}

function evaluateObjectProjection(
    source: AstNode | undefined,
    projection: 0 | 1,
    evaluate: RegistrationCollectionEvaluator
): RegistrationTypeCollection {
    const object = unwrap(source);
    if (object?.type !== 'ObjectExpression') {
        return UNKNOWN_REGISTRATION_TYPES;
    }
    const collections: RegistrationTypeCollection[] = [];
    for (const property of asNodes(object.properties)) {
        if (property.type === 'SpreadElement' || property.type === 'ObjectMethod') {
            return UNKNOWN_REGISTRATION_TYPES;
        }
        const projected = projection === 0
            ? property.computed === true ? asNode(property.key) : undefined
            : asNode(property.value);
        collections.push(projected ? evaluate(projected) : UNKNOWN_REGISTRATION_TYPES);
    }
    return mergeTypes(collections);
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
        return undefined;
    }
    if (
        parameter.type !== 'Identifier' ||
        (body.type !== 'MemberExpression' && body.type !== 'OptionalMemberExpression') ||
        readName(body.object) !== readName(parameter) || body.computed !== true
    ) {
        return undefined;
    }
    const index = readNumber(body.property);
    return index === 0 || index === 1 ? index : undefined;
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

function mergeTypes(
    collections: readonly RegistrationTypeCollection[]
): RegistrationTypeCollection {
    const types = new Set<string>();
    let unknown = false;
    for (const collection of collections) {
        if (collection.kind === 'unknown') {
            unknown = true;
        }
        for (const type of collection.types) {
            types.add(type);
        }
    }
    return unknown ? unknownRegistrationTypes(types) : knownRegistrationTypes(types);
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

function readNumber(value: unknown): number | undefined {
    const node = asNode(value);
    return node?.type === 'NumericLiteral' && typeof node.value === 'number' ? node.value : undefined;
}

function asNode(value: unknown): AstNode | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
}

function asNodes(value: unknown): readonly AstNode[] {
    return Array.isArray(value)
        ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
        : [];
}
