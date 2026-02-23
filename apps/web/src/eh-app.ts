import {getRouteFromHash, Route} from './router.ts';
import {findEl} from "./utils/utils.ts";
import type {ChatScreen} from './chat/chat-screen.ts';
import {addWebSocketDataHandler} from "./transport/websocket-data-router.ts";
import {webSocketClientId, webSocketQueueBox} from "./transport/websocket-engine.ts";
import {toResourceEntry} from "@shared/queuebox/ResourceEntry.ts";

export class EhApp extends HTMLElement {
    private currentRoute: Route = Route.Landing;

    connectedCallback(): void {
        self.window.addEventListener('hashchange', this.onHashChange);
        this.currentRoute = getRouteFromHash(location.hash);
        this.render();
    }

    disconnectedCallback(): void {
        self.window.removeEventListener('hashchange', this.onHashChange);
    }

    private onHashChange = (): void => {
        const next = getRouteFromHash(location.hash);
        if (next !== this.currentRoute) {
            this.currentRoute = next;
            this.render();
        }
    };

    private render(): void {
        this.innerHTML =
            `
              <div class="card">
                <div class="row">
                  <strong>EyeHunter</strong>
                  <span class="muted">/ Tic-Tac-Toe</span>
                  <span style="margin-left:auto" class="muted">
                    <a href="#/">Home</a>
                  </span>
                </div>
              </div>
        
              <div id="screenHost"></div>
            `;

        const host = findEl<HTMLDivElement>(this, '#screenHost');

        switch (this.currentRoute) {
            case Route.TicTacToe:
                host.innerHTML = `<eh-landing></eh-landing>`;
                return;
            case Route.WhackAWorm:
                host.innerHTML = `<eh-whack-home-screen></eh-whack-home-screen>`;
                return;
            case Route.WhackSingle:
                host.innerHTML = `<eh-whack-single-screen></eh-whack-single-screen>`;
                return;
            case Route.Chat: {
                host.innerHTML = `<chat-screen></chat-screen>`;

                const chat = document.querySelector('chat-screen') as ChatScreen | null;
                if (!chat) {
                    throw new Error('chat-screen not found');
                }

                chat.configure({
                    onSend: async (text) => {
                        const data =
                            {
                                clientId: webSocketClientId,
                                message: text
                            }

                        console.log(`Sending message: ` + JSON.stringify(data));
                        await webSocketQueueBox.outbox.enqueue(toResourceEntry(webSocketQueueBox.input.outboxTypeId, data))
                    },
                    onReady: (api) => {
                        api.addMessage({role: 'peer', text: 'Connected.'});
                    }
                });

                addWebSocketDataHandler(
                    Route.Chat,
                    (data) => {
                        console.log(`Received message: ` + JSON.stringify(data));

                        if (data.message === undefined) {
                            console.error('Invalid message received from server');
                            return;
                        }
                        if (data.clientId === webSocketClientId) {
                            console.error('Received back my own message. Ignoring it');
                            return;
                        }

                        chat.addMessage({role: 'peer', text: data.message});
                    }
                )

                return;
            }
            case Route.Single:
                host.innerHTML = `<eh-single-screen></eh-single-screen>`;
                return;
            case Route.Multi:
                host.innerHTML = `<eh-multi-screen></eh-multi-screen>`;
                return;
            case Route.P2P:
                host.innerHTML = `<eh-p2p-multi-screen></eh-p2p-multi-screen>`;
                return;
            case Route.Landing:
            default:
                host.innerHTML = `<eh-landing-screen></eh-landing-screen>`;
                return;
        }
    }
}

customElements.define('eh-app', EhApp);
