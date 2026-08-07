import {
  type AuthTestAstNode,
  readAstNode,
  readAstNodes,
  readAstString,
} from './auth-server-test-ast.ts';
import type { AuthTestSemanticFact } from './auth-server-test-semantic-contracts.ts';

export function readAuthTestDeclarationFacts(
  root: AuthTestAstNode,
): readonly AuthTestSemanticFact[] {
  const program = readAstNode(root, 'program');
  if (program === undefined) return [];
  return readAstNodes(program, 'body').flatMap(toDeclarationFacts);
}

function toDeclarationFacts(statement: AuthTestAstNode): readonly AuthTestSemanticFact[] {
  const declaration =
    statement.type === 'ExportNamedDeclaration' ? readAstNode(statement, 'declaration') : undefined;
  if (declaration === undefined) return [];
  if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
    const name = readIdentifierName(readAstNode(declaration, 'id'));
    return name === undefined
      ? []
      : [{ kind: 'declaration', value: `${declaration.type}:${name}` }];
  }
  if (
    declaration.type === 'TSTypeAliasDeclaration' ||
    declaration.type === 'TSInterfaceDeclaration'
  ) {
    const name = readIdentifierName(readAstNode(declaration, 'id'));
    return name === undefined
      ? []
      : [{ kind: 'declaration', value: `${declaration.type}:${name}` }];
  }
  return readAstNodes(declaration, 'declarations').flatMap((declarator) => {
    const name = readIdentifierName(readAstNode(declarator, 'id'));
    return name === undefined ? [] : [{ kind: 'declaration' as const, value: `value:${name}` }];
  });
}

function readIdentifierName(node: AuthTestAstNode | undefined): string | undefined {
  return node?.type === 'Identifier' ? readAstString(node, 'name') : undefined;
}
