import { expect, test } from 'bun:test';
import { generateVAPIDKeys } from 'web-push';
import { validDecodeApiV1ConfigurationInput } from './api-v1-configuration-test-fixture.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { readApiV1ConfigurationEnvironment } from '../../src/configuration/read-api-v1-configuration-environment.ts';

test('court alerts require a valid server key pair supplied through the secret environment', () => {
    const input = validDecodeApiV1ConfigurationInput();
    const credentials = { subject: 'mailto:alerts@example.com', ...generateVAPIDKeys() };
    const secrets = input.secretsSource;
    if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) throw new TypeError('Expected fixture secrets.');
    const decode = (secret: string) => {
        const environment = readApiV1ConfigurationEnvironment({ RALLAR_WEB_PUSH_VAPID_JSON: secret });
        return decodeApiV1Configuration({ ...input, secretsSource: { ...secrets, ...environment.secretsSource } }).webPush;
    };
    expect(decodeApiV1Configuration(input).webPush).toBeNull();
    expect(decode(JSON.stringify(credentials))).toEqual(credentials);
    expect(() => decode(JSON.stringify({ ...credentials, privateKey: generateVAPIDKeys().privateKey }))).toThrow();
});
