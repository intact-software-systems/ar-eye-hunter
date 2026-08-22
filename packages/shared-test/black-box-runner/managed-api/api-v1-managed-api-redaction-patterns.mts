export const MANAGED_SECRET_ENV_KEY = new RegExp(
    [
        '(?:^|_)(?:PASSWORD|PASSWD|TOKEN|SECRET|DATABASE_URL|API_KEY|ACCESS_KEY|',
        'PRIVATE_KEY|CREDENTIALS?)(?:_|$)'
    ].join(''),
    'i'
);
export const URL_USERINFO_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s/]+)(@)/gi;
export const BEARER_CREDENTIAL = /(\bBearer\s+)[^\s,;]+/gi;
export const SENSITIVE_QUERY_VALUE = new RegExp(
    [
        '([?&][^=\\s&#]*(?:password|passwd|token|secret|api[_-]?key|access[_-]?key|',
        'signature|credential)[^=\\s&#]*=)([^&#\\s]*)'
    ].join(''),
    'gi'
);
export const SENSITIVE_ASSIGNMENT = new RegExp(
    [
        '(\\b[A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY|CREDENTIAL)',
        '[A-Z0-9_]*\\s*[:=]\\s*)([^\\s,;&]+)'
    ].join(''),
    'gi'
);
