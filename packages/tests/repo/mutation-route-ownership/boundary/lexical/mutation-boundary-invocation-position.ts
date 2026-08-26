import {
    asCapabilityNode as asNode,
    unwrapCapabilityExpression as unwrap,
    type MutationBoundaryCapabilityAstNode as AstNode
} from '../capabilities/mutation-boundary-capability-ast.ts';
import type { MutationBoundaryLexicalValues } from './mutation-boundary-lexical-values.ts';

export interface InvocationPositionContext {
    readonly activeFunctionKey?: string;
    readonly invocationPosition?: number;
    readonly lexical: MutationBoundaryLexicalValues;
}

export function readInvocationCallablePosition(
    value: AstNode | undefined,
    position: number,
    context: InvocationPositionContext
): number {
    const identifier = rootIdentifier(value);
    if (!identifier || !context.activeFunctionKey || context.invocationPosition === undefined) {
        return position;
    }
    const bindingFunction = context.lexical.bindings.identifierFunctionKey(identifier);
    return bindingFunction && bindingFunction !== context.activeFunctionKey
        ? context.invocationPosition
        : position;
}

function rootIdentifier(value: AstNode | undefined): AstNode | undefined {
    const node = unwrap(value);
    if (node?.type === 'Identifier') {
        return node;
    }
    if (node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression') {
        return rootIdentifier(asNode(node.object));
    }
    return undefined;
}
