import { parse } from '@babel/parser';
import type { Node } from '@babel/types';

/** A name that says it holds a time: a timeout, deadline, wait, poll, interval, delay, hold or duration, or `…Ms`. */
const TIMING_NAME = /timeout|deadline|wait|interval|poll|delay|hold|ttl|grace|settle|elapsed|duration|backoff|(?:Ms|_MS|Seconds|_SECONDS)$/i;

/** A name that counts something, whatever else it says: attempts, cycles, a count, a size or a length. */
const COUNT_NAME = /(?:attempts|cycles|count|size|length)$/i;

/** An upper-case constant's name. */
const CONSTANT_NAME = /^[A-Z][A-Z\d_]*$/;

/** The nodes that open a function's body. */
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ClassMethod',
    'ClassPrivateMethod',
    'ObjectMethod'
]);

/** A call whose arguments are times: a timer, a wait, a sleep, a hold, a poll, a retry or a bounded race. */
const TIMING_CALLEE = /^(?:setTimeout|setInterval)$|wait|sleep|within|hold|poll|delay|timeout|retry|until/i;

/** A call that reads a clock. */
const CLOCK_CALLEE = /now$/i;

/** The matchers whose argument is the asserted value, never a limit. */
const EXPECTED_VALUE_MATCHERS: ReadonlySet<string> = new Set(['toBe', 'toEqual', 'toMatchObject', 'toStrictEqual']);

/** Expressions a literal passes through on its way to the position that decides what it is. */
const TRANSPARENT_TYPES: ReadonlySet<string> = new Set([
    'ArrayExpression',
    'ObjectExpression',
    'ParenthesizedExpression',
    'TSAsExpression',
    'TSSatisfiesExpression',
    'UnaryExpression',
    'ConditionalExpression',
    'SpreadElement'
]);

type Verdict = 'wait' | 'value' | 'continue';

/** The name a property key, binding or callee is known by, if it has one. */
function toName(node: Node | null | undefined): string | undefined {
    if (!node) {
        return undefined;
    }
    switch (node.type) {
        case 'Identifier':
            return node.name;
        case 'PrivateName':
            return node.id.name;
        case 'StringLiteral':
            return node.value;
        case 'MemberExpression':
        case 'OptionalMemberExpression':
            return toName(node.property);
        default:
            return undefined;
    }
}

/** Whether an expression is a time: a timing name, a clock read, or arithmetic over one. */
function isTimeValue(node: Node): boolean {
    switch (node.type) {
        case 'Identifier':
        case 'MemberExpression':
        case 'OptionalMemberExpression':
            return TIMING_NAME.test(toName(node) ?? '') && !COUNT_NAME.test(toName(node) ?? '');
        case 'CallExpression':
        case 'OptionalCallExpression':
            return CLOCK_CALLEE.test(toName(node.callee) ?? '');
        case 'BinaryExpression':
            return isTimeValue(node.left) || isTimeValue(node.right);
        case 'ParenthesizedExpression':
        case 'TSAsExpression':
            return isTimeValue(node.expression);
        default:
            return false;
    }
}

/** Whether a value is a count, by which a time may be multiplied: a counting name or a `.length`. */
function isCountValue(node: Node): boolean {
    return (node.type === 'Identifier' || node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') &&
        COUNT_NAME.test(toName(node) ?? '');
}

/** Whether `child` is one of the arguments of a matcher that asserts the value it is given. */
function isExpectedValueArgument(parent: Node, child: Node): boolean {
    return (parent.type === 'CallExpression' || parent.type === 'OptionalCallExpression') &&
        EXPECTED_VALUE_MATCHERS.has(toName(parent.callee) ?? '') && parent.arguments.some((argument) => argument === child);
}

/** The name the nearest enclosing function is known by: its own, its method key's or its binding's. */
function toEnclosingFunctionName(outer: readonly Node[]): string | undefined {
    const index = outer.findIndex((node) => FUNCTION_TYPES.has(node.type));
    const fn = outer[index];
    if (fn === undefined) {
        return undefined;
    }
    if ('id' in fn && fn.id) {
        return toName(fn.id);
    }
    if ('key' in fn) {
        return toName(fn.key);
    }
    const binding = outer[index + 1];
    return binding?.type === 'VariableDeclarator' ? toName(binding.id) : undefined;
}

/** What a call's argument is: a time to a timing call, or to `Math.min`/`Math.max` beside a time; else a value. */
function judgeCallArgument(call: Node & { arguments: readonly Node[]; callee: Node; }, argument: Node): Verdict {
    const callee = toName(call.callee) ?? '';
    if (TIMING_CALLEE.test(callee)) {
        return 'wait';
    }
    if ((callee === 'min' || callee === 'max') && call.arguments.some((other) => other !== argument && isTimeValue(other))) {
        return 'wait';
    }
    return 'value';
}

/**
 * What an operand is: added to or taken from a time, a time; multiplied by a count, or multiplied or divided by
 * another literal, a time whose product is judged where it goes; multiplied or divided by anything else, a count or a
 * unit; compared, a value. Arithmetic over literals alone is judged where its result goes.
 */
function judgeArithmeticOperand(parent: Node & { left: Node; right: Node; operator: string; }, child: Node): Verdict {
    const other = parent.left === child ? parent.right : parent.left;
    if (parent.operator === '+' || parent.operator === '-') {
        return isTimeValue(other) ? 'wait' : 'continue';
    }
    if (parent.operator === '*' && isCountValue(other)) {
        return 'continue';
    }
    if (parent.operator === '*' || parent.operator === '/') {
        return other.type === 'NumericLiteral' ? 'continue' : 'value';
    }
    return 'value';
}

/**
 * What a binding's initializer is: a time when its name is one, unless it is an upper-case constant declared outside
 * any function, which names its value.
 */
function judgeBindingInitializer(name: string, outer: readonly Node[]): Verdict {
    if (!TIMING_NAME.test(name)) {
        return 'value';
    }
    return CONSTANT_NAME.test(name) && !outer.some((node) => FUNCTION_TYPES.has(node.type)) ? 'value' : 'wait';
}

/** What a returned value is: a time when the function that returns it is named for one. */
function judgeReturnedValue(outer: readonly Node[]): Verdict {
    return TIMING_NAME.test(toEnclosingFunctionName(outer) ?? '') ? 'wait' : 'value';
}

/** What the position a literal reached through `child` makes it, one ancestor at a time; `outer` lies beyond `parent`. */
function judgePosition(parent: Node, child: Node, outer: readonly Node[]): Verdict {
    switch (parent.type) {
        case 'BinaryExpression':
            return judgeArithmeticOperand(parent, child);
        case 'LogicalExpression':
            return parent.right === child && parent.operator !== '&&' ? 'wait' : 'continue';
        case 'CallExpression':
        case 'OptionalCallExpression':
        case 'NewExpression':
            return parent.callee === child ? 'value' : judgeCallArgument(parent, child);
        case 'ObjectProperty':
        case 'ClassProperty':
        case 'ClassPrivateProperty':
        case 'ClassAccessorProperty':
            return parent.value === child && TIMING_NAME.test(toName(parent.key) ?? '') ? 'wait' : 'value';
        case 'AssignmentPattern':
        case 'AssignmentExpression':
            return parent.right === child && TIMING_NAME.test(toName(parent.left) ?? '') ? 'wait' : 'value';
        case 'VariableDeclarator':
            return judgeBindingInitializer(toName(parent.id) ?? '', outer);
        case 'ReturnStatement':
            return judgeReturnedValue(outer);
        case 'ArrowFunctionExpression':
            return parent.body === child ? judgeReturnedValue([parent, ...outer]) : 'value';
        default:
            return TRANSPARENT_TYPES.has(parent.type) ? 'continue' : 'value';
    }
}

/** Whether the path from a literal enters a value matcher's call through its arguments, never through its callee. */
function isAssertedValue(literal: Node, ancestors: readonly Node[]): boolean {
    return ancestors.some((parent, index) => isExpectedValueArgument(parent, index === 0 ? literal : ancestors[index - 1]));
}

/** Whether a literal, reached through its ancestors (nearest first), is passed as a wait bound. */
function isLiteralWaitBound(literal: Node, ancestors: readonly Node[]): boolean {
    let child = literal;
    for (const [index, parent] of ancestors.entries()) {
        const verdict = judgePosition(parent, child, ancestors.slice(index + 1));
        if (verdict !== 'continue') {
            return verdict === 'wait' && !isAssertedValue(literal, ancestors);
        }
        child = parent;
    }
    return false;
}

/** Calls `visit` with every node of the tree and its ancestors, nearest first. */
function walk(node: Node, ancestors: readonly Node[], visit: (node: Node, ancestors: readonly Node[]) => void): void {
    visit(node, ancestors);
    const inner = [node, ...ancestors];
    for (const [key, value] of Object.entries(node)) {
        if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') {
            continue;
        }
        for (const child of Array.isArray(value) ? value : [value]) {
            if (typeof child === 'object' && child !== null && typeof child.type === 'string') {
                walk(child, inner, visit);
            }
        }
    }
}

/**
 * Each line of a TypeScript source that passes a nonzero numeric literal as a wait bound, as `line: text`. A literal
 * is a wait bound by where it goes: the value of a property, class field, binding, assignment or default whose name
 * is a time; a value returned by a function named for a time; an argument of a timing call; an operand added to or
 * taken from a time; an argument of `Math.min` or `Math.max` beside a time; or the fallback of `??` or `||`. A literal
 * times a count is judged where the product goes. The initializer of an upper-case constant outside any function
 * names its value, and a literal inside an argument of a value matcher (`toBe`, `toEqual`, `toMatchObject`,
 * `toStrictEqual`) is an asserted expectation, so neither counts; a matcher reached through its callee, as in
 * `expect.poll(read, { timeout: 15_000 }).toBe(true)`, exempts nothing.
 */
export function findLiteralWaitBounds(source: string): readonly string[] {
    const lines = source.split('\n');
    const program = parse(source, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true }).program;
    const found = new Set<number>();
    walk(program, [], (node, ancestors) => {
        if (node.type === 'NumericLiteral' && node.value !== 0 && node.loc && isLiteralWaitBound(node, ancestors)) {
            found.add(node.loc.start.line);
        }
    });
    return [...found].sort((left, right) => left - right).map((line) => `${line}: ${lines[line - 1].trim()}`);
}
