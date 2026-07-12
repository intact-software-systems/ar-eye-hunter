import { RETENTION_PLAN_TOKEN_MAX_LENGTH } from './retention-plan-token.ts';

export type RetentionCleanupQuery =
  | Readonly<{ mode: 'legacy' }>
  | Readonly<{ mode: 'preview' }>
  | Readonly<{ mode: 'confirm'; planToken: string }>
  | Readonly<{ mode: 'invalid'; error: string }>;

const PLAN_TOKEN_PATTERN = /^v1\.[0-9a-z]+\.[A-Za-z0-9_-]+$/;

export function parseRetentionCleanupQuery(url: URL): RetentionCleanupQuery {
  const dryRunValues = url.searchParams.getAll('dryRun');
  const planTokenValues = url.searchParams.getAll('planToken');

  if (dryRunValues.length > 1 || planTokenValues.length > 1) {
    return invalid('Retention preview and confirmation query values must not be duplicated.');
  }
  if (dryRunValues.length === 1 && planTokenValues.length === 1) {
    return invalid('Retention preview and confirmation cannot be requested together.');
  }
  if (dryRunValues.length === 1) {
    return dryRunValues[0] === 'true'
      ? { mode: 'preview' }
      : invalid('dryRun must be exactly true when provided.');
  }
  if (planTokenValues.length === 1) {
    const planToken = planTokenValues[0];
    if (
      planToken.length === 0 ||
      planToken.length > RETENTION_PLAN_TOKEN_MAX_LENGTH ||
      !PLAN_TOKEN_PATTERN.test(planToken)
    ) {
      return invalid('planToken is malformed.');
    }
    return { mode: 'confirm', planToken };
  }
  return { mode: 'legacy' };
}

function invalid(error: string): RetentionCleanupQuery {
  return { mode: 'invalid', error };
}
