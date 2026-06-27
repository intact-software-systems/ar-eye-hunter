export type EnvReader = Readonly<{
  get(key: string): string | undefined;
}>;

export type ProductionEnvHardeningErrorDetail = Readonly<{
  variable: string;
  message: string;
}>;

export class ProductionEnvHardeningError extends Error {
  public override readonly name = 'ProductionEnvHardeningError';

  public constructor(
    public readonly target: string,
    public readonly errors: readonly ProductionEnvHardeningErrorDetail[],
  ) {
    super(formatProductionEnvHardeningMessage(target, errors));
  }
}

export function isProductionHardeningEnabled(env: EnvReader): boolean {
  if (isTruthy(readEnv(env, 'RALLAR_PRODUCTION_HARDENING'))) {
    return true;
  }

  const environment = readEnv(env, 'ENVIRONMENT')?.toLowerCase();
  return environment === 'prod' || environment === 'production';
}

export function collectApiV1ProductionEnvErrors(
  env: EnvReader,
): readonly ProductionEnvHardeningErrorDetail[] {
  if (!isProductionHardeningEnabled(env)) {
    return [];
  }

  const errors: ProductionEnvHardeningErrorDetail[] = [];
  requireEquals(errors, env, 'RALLAR_SQL_BACKEND', 'postgres');
  requirePresent(errors, env, 'DATABASE_URL', 'Postgres database URL is required.');
  requireExactHttpsOrigins(errors, env, 'CORS_ORIGINS');
  requireTruthy(errors, env, 'RALLAR_STATE_STRICT_READ_AUTH');
  requireEquals(errors, env, 'AUTH_REGISTRATION_MODE', 'admin');
  requireAdminClientIds(errors, env);
  requireEquals(errors, env, 'AUTH_STATIC_CLIENTS_MODE', 'disabled');
  requireEquals(errors, env, 'RALLAR_ICE_MODE', 'metered');
  requirePresent(errors, env, 'METERED_APP_NAME', 'Metered TURN app name is required.');
  requirePresent(errors, env, 'METERED_API_KEY', 'Metered TURN API key is required.');
  requirePresent(
    errors,
    env,
    'RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET',
    'Operator token signing secret is required.',
  );
  requireList(errors, env, 'RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS');
  requirePositiveInteger(errors, env, 'RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS');
  return errors;
}

export function collectRelicProductionEnvErrors(
  env: EnvReader,
): readonly ProductionEnvHardeningErrorDetail[] {
  if (!isProductionHardeningEnabled(env)) {
    return [];
  }

  const errors = [...collectApiV1ProductionEnvErrors(env)];
  requireEquals(errors, env, 'RELIC_REST_AUTH_MODE', 'group-policy');
  return errors;
}

export function collectBlackBoxControlProductionEnvErrors(
  env: EnvReader,
): readonly ProductionEnvHardeningErrorDetail[] {
  if (!isProductionHardeningEnabled(env)) {
    return [];
  }

  const errors: ProductionEnvHardeningErrorDetail[] = [];
  requireExactHttpsOrigins(errors, env, 'RALLAR_BLACK_BOX_ALLOWED_ORIGINS');
  requireTruthy(errors, env, 'RALLAR_BLACK_BOX_REQUIRE_TLS');
  requireTruthy(errors, env, 'RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN');
  requireTruthy(errors, env, 'RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN');
  requirePresent(
    errors,
    env,
    'RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET',
    'Operator token verification secret is required.',
  );
  requireAnyList(
    errors,
    env,
    'RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS',
    'RALLAR_BLACK_BOX_HTTP_ALLOWED_ORIGINS',
    'HTTP command destinations must be restricted.',
  );
  requireAnyList(
    errors,
    env,
    'RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS',
    'RALLAR_BLACK_BOX_WS_ALLOWED_ORIGINS',
    'WebSocket command destinations must be restricted.',
  );
  requirePresent(
    errors,
    env,
    'RALLAR_BLACK_BOX_STORAGE_DIR',
    'Durable artifact storage directory is required.',
  );
  requirePositiveInteger(errors, env, 'RALLAR_BLACK_BOX_RETENTION_MAX_RUNS');
  return errors;
}

export function assertApiV1ProductionEnv(env: EnvReader): void {
  throwIfErrors('API-v1', collectApiV1ProductionEnvErrors(env));
}

export function assertRelicProductionEnv(env: EnvReader): void {
  throwIfErrors('Relic server', collectRelicProductionEnvErrors(env));
}

export function assertBlackBoxControlProductionEnv(env: EnvReader): void {
  throwIfErrors('black-box control', collectBlackBoxControlProductionEnvErrors(env));
}

function throwIfErrors(
  target: string,
  errors: readonly ProductionEnvHardeningErrorDetail[],
): void {
  if (errors.length > 0) {
    throw new ProductionEnvHardeningError(target, errors);
  }
}

function formatProductionEnvHardeningMessage(
  target: string,
  errors: readonly ProductionEnvHardeningErrorDetail[],
): string {
  const details = errors
    .map((error) => `- ${error.variable}: ${error.message}`)
    .join('\n');
  return `${target} production environment hardening failed:\n${details}`;
}

function requirePresent(
  errors: ProductionEnvHardeningErrorDetail[],
  env: EnvReader,
  variable: string,
  message: string,
): void {
  if (!readEnv(env, variable)) {
    errors.push({ variable, message });
  }
}

function requireList(
  errors: ProductionEnvHardeningErrorDetail[],
  env: EnvReader,
  variable: string,
): void {
  if (readList(env, variable).length === 0) {
    errors.push({ variable, message: 'At least one value is required.' });
  }
}

function requireAnyList(
  errors: ProductionEnvHardeningErrorDetail[],
  env: EnvReader,
  primaryVariable: string,
  secondaryVariable: string,
  message: string,
): void {
  if (
    readList(env, primaryVariable).length === 0 &&
    readList(env, secondaryVariable).length === 0
  ) {
    errors.push({
      variable: primaryVariable,
      message: `${message} Set ${primaryVariable} or ${secondaryVariable}.`,
    });
  }
}

function requireEquals(
  errors: ProductionEnvHardeningErrorDetail[],
  env: EnvReader,
  variable: string,
  expected: string,
): void {
  if (readEnv(env, variable) !== expected) {
    errors.push({ variable, message: `Must be set to ${expected}.` });
  }
}

function requireTruthy(
  errors: ProductionEnvHardeningErrorDetail[],
  env: EnvReader,
  variable: string,
): void {
  if (!isTruthy(readEnv(env, variable))) {
    errors.push({ variable, message: 'Must be enabled.' });
  }
}

function requirePositiveInteger(
  errors: ProductionEnvHardeningErrorDetail[],
  env: EnvReader,
  variable: string,
): void {
  const value = readEnv(env, variable);
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    errors.push({ variable, message: 'Must be a positive integer.' });
  }
}

function requireAdminClientIds(
  errors: ProductionEnvHardeningErrorDetail[],
  env: EnvReader,
): void {
  const ids = readList(env, 'AUTH_ADMIN_CLIENT_IDS');
  if (ids.length === 0) {
    errors.push({
      variable: 'AUTH_ADMIN_CLIENT_IDS',
      message: 'At least one runtime admin client id is required.',
    });
    return;
  }

  if (ids.some((id) => id.toLowerCase() === 'admin')) {
    errors.push({
      variable: 'AUTH_ADMIN_CLIENT_IDS',
      message: 'The default demo admin client id is not allowed in production.',
    });
  }
}

function requireExactHttpsOrigins(
  errors: ProductionEnvHardeningErrorDetail[],
  env: EnvReader,
  variable: string,
): void {
  const origins = readList(env, variable);
  if (origins.length === 0) {
    errors.push({
      variable,
      message: 'At least one exact HTTPS origin is required.',
    });
    return;
  }

  const invalid = origins.find((origin) => !isExactHttpsProductionOrigin(origin));
  if (invalid) {
    errors.push({
      variable,
      message: 'Only exact HTTPS origins are allowed; wildcards and localhost are not allowed.',
    });
  }
}

function isExactHttpsProductionOrigin(origin: string): boolean {
  if (origin === '*') {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch (_error) {
    return false;
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  return !hostname.includes('*') &&
    hostname !== 'localhost' &&
    hostname !== '127.0.0.1' &&
    hostname !== '0.0.0.0' &&
    hostname !== '::1' &&
    !hostname.endsWith('.localhost');
}

function readEnv(env: EnvReader, key: string): string | undefined {
  const value = env.get(key)?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readList(env: EnvReader, key: string): readonly string[] {
  return (readEnv(env, key) ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on';
}
