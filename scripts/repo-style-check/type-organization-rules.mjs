import { findMatchingBrace, lineFromOffset, lineOffsets } from './source-text.mjs';

export const typeOrganizationRuleIds = Object.freeze({
  renameAlias: 'types.rename-alias',
  runtimeNamespace: 'types.runtime-namespace',
  enumDeclaration: 'types.enum-declaration',
});

const semanticPrimitiveNames = new Set([
  'any',
  'bigint',
  'boolean',
  'never',
  'null',
  'number',
  'object',
  'string',
  'symbol',
  'this',
  'undefined',
  'unknown',
  'void',
]);

export function scanTypeOrganizationFindings(raw) {
  return [
    ...scanRenameOnlyTypeAliases(raw),
    ...scanNamespaceRuntimeMembers(raw),
    ...scanEnumDeclarations(raw),
  ];
}

export function scanRenameOnlyTypeAliases(raw) {
  const renameAliasPattern = new RegExp(
    String.raw`(^|\n)[ \t]*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)` +
      String.raw`\s*=\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*;`,
    'gu',
  );
  const offsets = lineOffsets(raw);
  const findings = [];
  let match;

  while ((match = renameAliasPattern.exec(raw)) !== null) {
    const aliasName = match[2];
    const renamedType = match[3].replace(/\s+/gu, '');
    if (semanticPrimitiveNames.has(renamedType)) {
      continue;
    }

    const line = lineFromOffset(offsets, match.index + match[1].length);
    findings.push({
      ruleId: typeOrganizationRuleIds.renameAlias,
      message:
        `Type alias "${aliasName}" at line ${line} only renames "${renamedType}". ` +
        'Use the canonical type name directly; an alias must define a genuinely new ' +
        'type expression.',
      symbol: aliasName,
    });
  }

  return findings;
}

export function scanNamespaceRuntimeMembers(raw) {
  const namespacePattern = new RegExp(
    String.raw`(^|\n)[ \t]*(?:export\s+)?namespace\s+([A-Za-z_$][\w$.]*)\s*\{`,
    'gu',
  );
  const offsets = lineOffsets(raw);
  const findings = [];
  let match;

  while ((match = namespacePattern.exec(raw)) !== null) {
    const braceIndex = match.index + match[0].length - 1;
    const closingIndex = findMatchingBrace(raw, braceIndex);
    if (closingIndex === -1) {
      continue;
    }

    const runtimeMembers = findRuntimeMemberEntries(raw.slice(braceIndex + 1, closingIndex));
    if (runtimeMembers.length === 0) {
      continue;
    }

    const namespaceName = match[2];
    const namespaceLine = lineFromOffset(offsets, match.index + match[1].length);
    const firstMemberLine = lineFromOffset(offsets, braceIndex + 1) + runtimeMembers[0].lineIndex;
    findings.push({
      ruleId: typeOrganizationRuleIds.runtimeNamespace,
      message:
        `Namespace "${namespaceName}" at line ${namespaceLine} contains ` +
        `${runtimeMembers.length} runtime member line(s), first at line ${firstMemberLine}. ` +
        'Keep associated namespaces type-only; move runtime values to module scope.',
      symbol: namespaceName,
      affectedCount: runtimeMembers.length,
    });
  }

  return findings;
}

export function scanEnumDeclarations(raw) {
  const enumPattern = /(^|\n)[ \t]*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/gu;
  const offsets = lineOffsets(raw);
  const findings = [];
  let match;

  while ((match = enumPattern.exec(raw)) !== null) {
    const enumName = match[2];
    const line = lineFromOffset(offsets, match.index + match[1].length);
    findings.push({
      ruleId: typeOrganizationRuleIds.enumDeclaration,
      message:
        `TypeScript enum "${enumName}" at line ${line} is not erasable syntax. ` +
        'Prefer a string-literal union type; use a plain const object when runtime ' +
        'values are required.',
      symbol: enumName,
    });
  }

  return findings;
}

function findRuntimeMemberEntries(namespaceBody) {
  const runtimeMemberPattern = new RegExp(
    String.raw`^[ \t]*(?:export[ \t]+)?(?:const|let|var|function|class|enum)[ \t]+`,
    'u',
  );
  return namespaceBody
    .split('\n')
    .map((text, lineIndex) => ({ lineIndex, code: text.split('//')[0] }))
    .filter((entry) => runtimeMemberPattern.test(entry.code));
}
