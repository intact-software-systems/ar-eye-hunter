import {
  findMatchingBrace,
  lineFromOffset,
  lineOffsets,
  skipWhitespaceAndComments,
  splitTopLevelItems,
} from './source-text.mjs';

const discouragedServiceNameParts = [
  'Manager',
  'Coordinator',
  'Orchestrator',
  'Broker',
  'Controller',
  'Gateway',
  'Facade',
  'Dispatcher',
];

const outputContractPrefixes = ['to', 'read', 'write', 'compute', 'create', 'resolve'];

export function scanDiscouragedServiceNames(raw) {
  const messages = [];
  const declarations = [
    /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*Service)\b/g,
    /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*Service)\b/g,
    /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*Service)\b/g,
  ];

  for (const declaration of declarations) {
    let match;
    while ((match = declaration.exec(raw)) !== null) {
      const name = match[1];
      const discouraged = discouragedServiceNameParts.some((part) => name.includes(part));
      if (!discouraged) {
        continue;
      }

      messages.push(
        `Service-like type "${name}" includes a discouraged compound role ` +
          `(${discouragedServiceNameParts.join(', ')}). ` +
          'Prefer one explicit domain-capability name ending in `Service`.',
      );
    }
  }

  return messages;
}

export function scanFunctionInputContracts(functions, maxArgumentCount) {
  return functions
    .filter((fn) => fn.paramCount > maxArgumentCount)
    .map(
      (fn) =>
        `Function ${fn.name} at line ${fn.line} has ${fn.paramCount} parameters. ` +
        `Prefer one named input interface such as ${toPascalCase(fn.name)}Input.`,
    );
}

export function scanOutputContractNaming(raw, functions) {
  const messages = [];

  for (const fn of functions) {
    const usesCheckedPrefix = outputContractPrefixes.some((prefix) => fn.name.startsWith(prefix));
    const hasInlineObjectReturn = fn.returnType.includes('{');
    if (
      !usesCheckedPrefix ||
      fn.bodyStart < 0 ||
      fn.bodyEnd < 0 ||
      (fn.returnType.length > 0 && !hasInlineObjectReturn)
    ) {
      continue;
    }

    const body = raw.slice(fn.bodyStart + 1, fn.bodyEnd);
    const fieldCount = countReturnedObjectFields(body);
    if (fieldCount < 2) {
      continue;
    }

    messages.push(
      `Function ${fn.name} at line ${fn.line} returns a multi-field object ` +
        `(${fieldCount} fields) without an explicit output contract. ` +
        'Prefer a named output interface.',
    );
  }

  return messages;
}

export function extractCommandTypesWithOptionalFields(lines) {
  const commandTypes = [];
  const startPattern =
    /^(?:export\s+)?(?:type|interface)\s+([A-Za-z0-9_]*Command)\s*(?:<[^>]+>)?(?:\s*=\s*)?\{/;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const startMatch = lines[lineIndex].match(startPattern);
    if (!startMatch) {
      continue;
    }

    let depth = 0;
    const optionalFields = [];

    for (let fieldLineIndex = lineIndex; fieldLineIndex < lines.length; fieldLineIndex += 1) {
      const clean = lines[fieldLineIndex].split('//')[0];
      const openCount = (clean.match(/\{/g) ?? []).length;
      const closeCount = (clean.match(/\}/g) ?? []).length;

      if (fieldLineIndex > lineIndex) {
        const fieldMatch = clean.match(/^\s*(?:readonly\s+)?(?:[A-Za-z0-9_"]+)\s*\?\s*:/);
        if (fieldMatch) {
          optionalFields.push({
            line: fieldLineIndex + 1,
            text: clean.trim(),
          });
        }
      }

      depth += openCount - closeCount;
      if (fieldLineIndex > lineIndex && depth <= 0) {
        break;
      }
    }

    if (optionalFields.length > 0) {
      commandTypes.push({
        name: startMatch[1],
        fields: optionalFields,
      });
    }
  }

  return commandTypes;
}

export function scanPlainObjectTypeAliases(raw) {
  const messages = [];
  const aliasPattern = /(^|\n)\s*(?:export\s+)?type\s+([A-Za-z0-9_]+)(?:\s*<[^>]+>)?\s*=\s*\{/gu;
  const offsets = lineOffsets(raw);
  let match;

  while ((match = aliasPattern.exec(raw)) !== null) {
    const matchIndex = match.index + match[0].lastIndexOf('type');
    messages.push(
      `Type alias "${match[2]}" at line ${lineFromOffset(offsets, matchIndex)} ` +
        'is a plain object contract. Prefer interface when no alias feature ' +
        '(union, intersection, mapped type, tuple, function, or primitive) is required.',
    );
  }

  return messages;
}

// Counted per occurrence rather than per line. A formatter may split one declaration across two
// lines or join two into one; neither changes how much unknown the boundary actually propagates, so
// the magnitude must not move when only the wrapping does.
export function findUnknownUsages(lines) {
  return lines
    .map((text, index) => ({
      code: stripQuotedText(text).split('//')[0],
      line: index + 1,
      text: text.trim(),
    }))
    .flatMap((entry) => {
      const occurrenceCount = entry.code.match(/\bunknown\b/gu)?.length ?? 0;
      return Array.from({ length: occurrenceCount }, () => entry);
    });
}

function countReturnedObjectFields(body) {
  const returnPattern = /\breturn\b/g;
  let match;

  while ((match = returnPattern.exec(body)) !== null) {
    const objectStart = skipWhitespaceAndComments(body, match.index + 6);
    if (body[objectStart] !== '{') {
      continue;
    }

    const objectEnd = findMatchingBrace(body, objectStart);
    if (objectEnd === -1) {
      continue;
    }

    const fields = splitTopLevelItems(body.slice(objectStart + 1, objectEnd)).filter(
      (field) => field !== '',
    );
    if (fields.length >= 2) {
      return fields.length;
    }
  }

  return 0;
}

function toPascalCase(name) {
  return name.length === 0 ? name : `${name[0].toUpperCase()}${name.slice(1)}`;
}

function stripQuotedText(text) {
  return text
    .replace(/'(?:\\.|[^'\\])*'/gu, '')
    .replace(/"(?:\\.|[^"\\])*"/gu, '')
    .replace(/`(?:\\.|[^`\\])*`/gu, '');
}
