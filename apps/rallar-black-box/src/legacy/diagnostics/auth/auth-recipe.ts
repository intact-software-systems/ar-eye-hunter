import { json } from '../../shared/json-presentation.ts';

export function authRecipeSnippet(username: string): string {
    return json({
        recipeId: 'rallar-auth-command-center',
        name: 'Rallar auth command-center recipe',
        continueOnFailure: true,
        commands: [
            {
                kind: 'http.request',
                commandId: 'auth-login',
                request: {
                    path: '/api/auth/login',
                    method: 'POST',
                    body: {
                        username: username || '<username>',
                        password: '<password>',
                    },
                },
                response: {
                    body: 'json',
                },
            },
            {
                kind: 'http.request',
                commandId: 'auth-ws-ticket',
                request: {
                    path: '/api/auth/ws-ticket',
                    method: 'POST',
                    body: {},
                },
                response: {
                    body: 'json',
                },
            },
            {
                kind: 'http.request',
                commandId: 'auth-missing-token-negative',
                request: {
                    path: '/api/auth/ws-ticket',
                    method: 'POST',
                    body: {},
                },
                response: {
                    body: 'json',
                },
                metadata: {
                    expectedStatus: 401,
                },
            },
        ],
    });
}
