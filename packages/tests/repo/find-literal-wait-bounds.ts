import { parse } from '@babel/parser';
import type { Node } from '@babel/types';

/** A name that says it holds a time: a timeout, deadline, wait, poll, interval, delay, hold or duration, or `…Ms`. */
const TIMING_NAME = /timeout|deadline|wait|interval|poll|delay|hold|ttl|grace|settle|elapsed|duration|backoff|(?:Ms|_MS|Seconds|_SECONDS)$/i;

/** A name that counts something, whatever else it says: attempts, cycles, a count or a size. */
const COUNT_NAME = /(?:ATTEMPTS|CYCLES|COUNT|SIZE|Attempts|Cycles|Count|Size)$/;

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

/** Whether a call is a matcher that asserts the value it is given. */
function isExpectedValueMatcher(node: Node): boolean {
    return (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') &&
        EXPECTED_VALUE_MATCHERS.has(toName(node.callee) ?? '');
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
 * What an operand is: added to or taken from a time, a time; multiplied or divided by anything but another literal, a
 * count or a unit; compared, a value. Arithmetic over literals alone is judged where its result goes.
 */
function judgeArithmeticOperand(parent: Node & { left: Node; right: Node; operator: string; }, child: Node): Verdict {
    const other = parent.left === child ? parent.right : parent.left;
    if (parent.operator === '+' || parent.operator === '-') {
        return isTimeValue(other) ? 'wait' : 'continue';
    }
    if (parent.operator === '*' || parent.operator === '/') {
        return other.type === 'NumericLiteral' ? 'continue' : 'value';
    }
    return 'value';
}

/** What the position a literal reached through `child` makes it, one ancestor at a time. */
function judgePosition(parent: Node, child: Node): Verdict {
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
            return parent.value === child && TIMING_NAME.test(toName(parent.key) ?? '') ? 'wait' : 'value';
        case 'AssignmentPattern':
            return TIMING_NAME.test(toName(parent.left) ?? '') ? 'wait' : 'value';
        case 'VariableDeclarator':
            return TIMING_NAME.test(toName(parent.id) ?? '') && !/^[A-Z][A-Z\d_]*$/.test(toName(parent.id) ?? '')
                ? 'wait'
                : 'value';
        default:
            return TRANSPARENT_TYPES.has(parent.type) ? 'continue' : 'value';
    }
}

/** Whether a literal, reached through its ancestors (nearest first), is passed as a wait bound. */
function isLiteralWaitBound(literal: Node, ancestors: readonly Node[]): boolean {
    let child = literal;
    for (const [index, parent] of ancestors.entries()) {
        const verdict = judgePosition(parent, child);
        if (verdict !== 'continue') {
            return verdict === 'wait' && !ancestors.slice(index).some(isExpectedValueMatcher);
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
 * is a wait bound by where it goes: the value of a property, binding or default whose name is a time; an argument of
 * a timing call; an operand added to or taken from a time; an argument of `Math.min` or `Math.max` beside a time; or
 * the fallback of `??` or `||`. The initializer of an upper-case constant names its value, and the argument of a
 * value matcher (`toBe`, `toEqual`, `toMatchObject`, `toStrictEqual`) is an asserted expectation, so neither counts.
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
