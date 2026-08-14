import { createHash } from 'node:crypto';

export function toCanonicalJson(value) {
  return JSON.stringify(toCanonicalValue(value));
}

export function computeSha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function toCanonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(toCanonicalValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, toCanonicalValue(value[key])]),
    );
  }
  return value;
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}
