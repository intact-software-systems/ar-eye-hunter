import { parse } from '@babel/parser';

/** The `APIRequestContext` methods that send a request, each taking its options second. */
const REQUEST_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']);

/** A receiver the harnesses name for the request context it is: `request`, `#request`, `input.request`, `page.request`. */
const REQUEST_RECEIVER_NAME = /request$/i;

interface SyntaxNode {
    readonly type: string;
    readonly loc?: Readonly<{ start: Readonly<{ line: number; }>; }> | null;
    readonly [key: string]: unknown;
}

function isSyntaxNode(value: unknown): value is SyntaxNode {
    return typeof value === 'object' && value !== null && typeof (value as { type?: unknown; }).type === 'string';
}

/** The name an identifier, private name or member expression is known by, if it has one. */
function toName(node: unknown): string | undefined {
    if (!isSyntaxNode(node)) {
        return undefined;
    }
    switch (node.type) {
        case 'Identifier':
            return typeof node.name === 'string' ? node.name : undefined;
        case 'PrivateName':
            return toName(node.id);
        case 'MemberExpression':
        case 'OptionalMemberExpression':
            return toName(node.property);
        default:
            return undefined;
    }
}

/** Whether a call sends a request through a request context: a request method of a receiver named for one. */
function isRequestCall(node: SyntaxNode): boolean {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') {
        return false;
    }
    const callee = node.callee;
    return isSyntaxNode(callee) && (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') &&
        REQUEST_METHODS.has(toName(callee.property) ?? '') && REQUEST_RECEIVER_NAME.test(toName(callee.object) ?? '');
}

/** Whether a request call's options are written out and name a `timeout` of their own. */
function namesTimeout(call: SyntaxNode): boolean {
    const options = (call.arguments as readonly unknown[])[1];
    return isSyntaxNode(options) && options.type === 'ObjectExpression' &&
        (options.properties as readonly unknown[]).some((property) =>
            isSyntaxNode(property) && property.type === 'ObjectProperty' && toName(property.key) === 'timeout'
        );
}

/** Calls `visit` with every node of the tree. */
function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
    visit(node);
    for (const [key, value] of Object.entries(node)) {
        if (key === 'loc' || key.endsWith('Comments')) {
            continue;
        }
        for (const child of Array.isArray(value) ? value : [value]) {
            if (isSyntaxNode(child)) {
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
    walk(program as unknown as SyntaxNode, (node) => {
        if (isRequestCall(node) && !namesTimeout(node) && node.loc) {
            found.add(node.loc.start.line);
        }
    });
    return [...found].sort((left, right) => left - right).map((line) => `${line}: ${lines[line - 1].trim()}`);
}
