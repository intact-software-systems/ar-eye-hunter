import { parse } from '@babel/parser';

type ProgramStatement = ReturnType<typeof parse>['program']['body'][number];
type NamedExport = Extract<ProgramStatement, { type: 'ExportNamedDeclaration' }>;
type ExportedDeclaration = NonNullable<NamedExport['declaration']>;

export const failClosedExportFixtures = [
  ['default', 'export default function named() {}'],
  ['wildcard', "export * from './other.ts';"],
  ['ts-export-assignment', 'export = value;'],
  ['namespace-specifier', "export * as Extra from './other.ts';"],
  ['destructured-binding', 'export const { extra } = { extra: 1 };'],
  ['qualified-module-name', 'export namespace A.B {}'],
  ['malformed-anonymous', 'export function () {}'],
] as const;

export function exportedNames(source: string): readonly string[] {
  const program = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program;
  return program.body.flatMap(exportedNamesFromStatement).sort();
}

function exportedNamesFromStatement(statement: ProgramStatement): readonly string[] {
  switch (statement.type) {
    case 'ExportNamedDeclaration':
      return exportedNamesFromNamedDeclaration(statement);
    case 'ExportDefaultDeclaration':
    case 'ExportAllDeclaration':
    case 'TSExportAssignment':
      throw new Error(`Unsupported export surface: ${statement.type}`);
    case 'TSNamespaceExportDeclaration':
      return [statement.id.name];
    default:
      return [];
  }
}

function exportedNamesFromNamedDeclaration(node: NamedExport): readonly string[] {
  const declared = node.declaration ? exportedDeclarationNames(node.declaration) : [];
  const specified = node.specifiers.flatMap((specifier) => {
    if (specifier.type !== 'ExportSpecifier') {
      throw new Error(`Unsupported named export specifier: ${specifier.type}`);
    }
    return specifier.exported.type === 'Identifier'
      ? [specifier.exported.name]
      : [specifier.exported.value];
  });
  return [...declared, ...specified];
}

function exportedDeclarationNames(declaration: ExportedDeclaration): readonly string[] {
  switch (declaration.type) {
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'TSDeclareFunction':
      if (!declaration.id) throw new Error(`Anonymous exported ${declaration.type}`);
      return [declaration.id.name];
    case 'VariableDeclaration':
      return declaration.declarations.flatMap(({ id }) => {
        if (id.type !== 'Identifier') {
          throw new Error(`Unsupported exported binding pattern: ${id.type}`);
        }
        return [id.name];
      });
    case 'TSInterfaceDeclaration':
    case 'TSTypeAliasDeclaration':
    case 'TSEnumDeclaration':
      return [declaration.id.name];
    case 'TSImportEqualsDeclaration':
      return [declaration.id.name];
    case 'TSModuleDeclaration':
      if (declaration.id.type === 'Identifier') return [declaration.id.name];
      if (declaration.id.type === 'StringLiteral') return [declaration.id.value];
      throw new Error(`Unsupported exported module name: ${declaration.id.type}`);
    default:
      throw new Error(`Unsupported named export declaration: ${declaration.type}`);
  }
}
