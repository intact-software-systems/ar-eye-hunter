import { parse } from '@babel/parser';
import type { CallExpression, Node, OptionalCallExpression } from '@babel/types';

/** The `APIRequestContext` methods that send a request, each taking its options second. */
const REQUEST_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']);

/** A receiver the harnesses name for the request context it is: `request`, `#request`, `input.request`, `page.request`. */
const REQUEST_RECEIVER_NAME = /request$/i;

/** The name an identifier, private name or member expression is known by, if it has one. */
function toName(node: Node | null | undefined): string | undefined {
    if (!node) {
        return undefined;
    }
    switch (node.type) {
        case 'Identifier':
            return node.name;
        case 'PrivateName':
            return node.id.name;
        case 'MemberExpression':
        case 'OptionalMemberExpression':
            return toName(node.property);
        default:
            return undefined;
    }
}

/** Whether a call sends a request through a request context: a request method of a receiver named for one. */
function isRequestCall(node: Node): node is CallExpression | OptionalCallExpression {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') {
        return false;
    }
    const callee = node.callee;
    return (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') &&
        REQUEST_METHODS.has(toName(callee.property) ?? '') && REQUEST_RECEIVER_NAME.test(toName(callee.object) ?? '');
}

/** Whether a request call's options are written out and name a `timeout` of their own. */
function namesTimeout(call: CallExpression | OptionalCallExpression): boolean {
    const options = call.arguments[1];
    return options?.type === 'ObjectExpression' &&
        options.properties.some((property) => property.type === 'ObjectProperty' && toName(property.key) === 'timeout');
}

/** Calls `visit` with every node of the tree. */
function walk(node: Node, visit: (node: Node) => void): void {
    visit(node);
    for (const [key, value] of Object.entries(node)) {
        if (key === 'loc' || key.endsWith('Comments')) {
            continue;
        }
        for (const child of Array.isArray(value) ? value : [value]) {
            if (typeof child === 'object' && child !== null && typeof child.type === 'string') {
                walk(child, visit);
            }
        }
    }
}

/**
 * Each line of a TypeScript source that sends a request through a Playwright request context without naming its
 * timeout, as `line: text`, so that no request runs under the context's own default. A request is known by its form:
 * a request method called on a receiver named for a request context, whose options must be an object literal with a
 * `timeout` property. Without type information a context held under another name goes unseen.
 */
export function findUntimedRequests(source: string): readonly string[] {
    const lines = source.split('\n');
    const program = parse(source, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true }).program;
    const found = new Set<number>();
    walk(program, (node) => {
        if (isRequestCall(node) && !namesTimeout(node) && node.loc) {
            found.add(node.loc.start.line);
        }
    });
    return [...found].sort((left, right) => left - right).map((line) => `${line}: ${lines[line - 1].trim()}`);
}
