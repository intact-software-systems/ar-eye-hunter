import type { CallExpression, Node, OptionalCallExpression, Program } from '@babel/types';

import { findSourceLines, toNodeName, walkNodes, type SourceNodeMatch } from './find-source-lines.ts';

/** The wrappers that time the `fetch` they are given, so handing them the bare global is how it is timed. */
const FETCH_TIMERS: ReadonlySet<string> = new Set(['toControlTimedFetch']);

/** The `APIRequestContext` methods that send a request, each taking its options second. */
const REQUEST_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']);

/**
 * A receiver the harnesses name for the request context it is: `request`, `#request`, `input.request`, `page.request`,
 * `requestContext`.
 */
const REQUEST_RECEIVER_NAME = /request(?:Context)?$/i;

/** A node with its casts, non-null assertions and parentheses taken off. */
function unwrap(node: Node): Node {
    switch (node.type) {
        case 'ParenthesizedExpression':
        case 'TSAsExpression':
        case 'TSSatisfiesExpression':
        case 'TSNonNullExpression':
        case 'TSTypeAssertion':
            return unwrap(node.expression);
        default:
            return node;
    }
}

/** The global `fetch` itself, whether named bare or through `globalThis`. */
function isGlobalFetch(node: Node): boolean {
    const value = unwrap(node);
    if (value.type === 'Identifier') {
        return value.name === 'fetch';
    }
    return (value.type === 'MemberExpression' || value.type === 'OptionalMemberExpression') &&
        toNodeName(value.property) === 'fetch' && toNodeName(unwrap(value.object)) === 'globalThis';
}

/** Every name a source binds to a request context by copying one: `const r = request`. */
function toRequestAliases(program: Program): ReadonlySet<string> {
    const aliases = new Set<string>();
    walkNodes(program, [], (node) => {
        if (
            node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init &&
            REQUEST_RECEIVER_NAME.test(toNodeName(unwrap(node.init)) ?? '')
        ) {
            aliases.add(node.id.name);
        }
    });
    return aliases;
}

/** Whether an option's value sets no bound: `undefined`, `void …`, or `0`, which Playwright reads as no timeout. */
function isNoBound(node: Node): boolean {
    const value = unwrap(node);
    return (value.type === 'Identifier' && value.name === 'undefined') ||
        (value.type === 'UnaryExpression' && value.operator === 'void') ||
        (value.type === 'NumericLiteral' && value.value === 0);
}

/** Whether a call's options are written out and give `key` a value that sets a bound. */
function namesOption(call: CallExpression | OptionalCallExpression, key: string): boolean {
    const options = call.arguments[1];
    return options?.type === 'ObjectExpression' &&
        options.properties.some((property) => property.type === 'ObjectProperty' && toNodeName(property.key) === key && !isNoBound(property.value));
}

/**
 * Whether a call sends a request with no bound of its own: a request context's method that names no `timeout`, or
 * the global `fetch` that names no `signal`. A `fetch` called on any other receiver is an injected dependency, which
 * the injector times.
 */
function isUntimedRequestCall(node: Node, aliases: ReadonlySet<string>): boolean {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') {
        return false;
    }
    if (isGlobalFetch(node.callee)) {
        return !namesOption(node, 'signal');
    }
    const callee = unwrap(node.callee);
    if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') {
        return false;
    }
    const receiver = toNodeName(unwrap(callee.object)) ?? '';
    return REQUEST_METHODS.has(toNodeName(callee.property) ?? '') &&
        (REQUEST_RECEIVER_NAME.test(receiver) || aliases.has(receiver)) && !namesOption(node, 'timeout');
}

/**
 * Whether a node hands an operator the bare global `fetch` as a dependency, untimed: as its `fetch` property, or as a
 * call's argument to anything but a fetch timer.
 */
function isUntimedFetchInjection(node: Node): boolean {
    if (node.type === 'ObjectProperty') {
        return toNodeName(node.key) === 'fetch' && isGlobalFetch(node.value);
    }
    return (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') &&
        !FETCH_TIMERS.has(toNodeName(unwrap(node.callee)) ?? '') &&
        node.arguments.some((argument) => isGlobalFetch(argument));
}

/**
 * Each line of a TypeScript source that sends a request without a bound of its own, as `line: text`, so that no
 * request runs under a default limit or none. A request is known by its form: a request method called on a receiver
 * named for a Playwright request context, or bound to one, must name a `timeout` in its options literal; the global
 * `fetch` must name a `signal`; `undefined`, `void …` and `0` name neither. A `fetch` an operator takes as a dependency
 * is timed where it is injected, so handing one the bare global, as a property or an argument, is refused there.
 * Without type information a context or fetch held under another name goes unseen.
 */
export function findUntimedRequests(source: string): readonly string[] {
    return findSourceLines(source, (program): SourceNodeMatch => {
        const aliases = toRequestAliases(program);
        return (node) => isUntimedRequestCall(node, aliases) || isUntimedFetchInjection(node);
    });
}
