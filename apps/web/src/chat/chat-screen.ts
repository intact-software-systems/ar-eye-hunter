import {findHtmlEl} from "../utils/utils.ts";
import {chatTopicId} from "@shared/api/api-config.ts";
import {appClientData} from "../middleware/config.ts";
import {middleware} from "../middleware/middleware.ts";
import * as ChatTransport from "../middleware/chat-transport.ts";

type ChatRole = 'me' | 'peer' | 'system';

export interface ChatMessage {
    id: string;
    role: ChatRole;
    text: string;
    createdAt: number;
}

export interface ChatScreenApi {
    addMessage: (message: Omit<ChatMessage, 'id' | 'createdAt'> & Partial<Pick<ChatMessage, 'id' | 'createdAt'>>) => void;
    clearMessages: () => void;
    getMessages: () => ReadonlyArray<ChatMessage>;
}

export interface ChatScreenCallbacks {
    onSend?: (text: string) => Promise<void> | void;
    onReady?: (api: ChatScreenApi) => void;
}

function escapeHtml(input: string): string {
    return input
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

export class ChatScreen extends HTMLElement {
    private callbacks: ChatScreenCallbacks = {};
    private messages: ChatMessage[] = [];
    private idCounter = 0;

    connectedCallback(): void {
        this.render();
        this.wire();
        this.callbacks.onReady?.(this.api);
        this.renderMessages();

        ChatTransport.connectTransport(
            this,
            middleware,
            chatTopicId,
            appClientData.clientId
        )
    }

    disconnectedCallback(): void {
        ChatTransport.disconnectTransport(chatTopicId);
    }

    public configure(callbacks: ChatScreenCallbacks): void {
        this.callbacks = callbacks;
        if (this.isConnected) {
            this.callbacks.onReady?.(this.api);
        }
    }

    public addMessage(message: Omit<ChatMessage, 'id' | 'createdAt'> & Partial<Pick<ChatMessage, 'id' | 'createdAt'>>): void {

        const next: ChatMessage = {
            id: message.id ?? `msg-${Date.now()}-${this.idCounter++}`,
            role: message.role,
            text: message.text,
            createdAt: message.createdAt ?? Date.now()
        };

        this.messages = [...this.messages, next];
        this.renderMessages();
    }

    public clearMessages(): void {
        this.messages = [];
        this.renderMessages();
    }

    public getMessages(): ReadonlyArray<ChatMessage> {
        return this.messages;
    }

    private readonly api: ChatScreenApi = {
        addMessage: (message) => this.addMessage(message),
        clearMessages: () => this.clearMessages(),
        getMessages: () => this.getMessages()
    };

    private render(): void {
        this.innerHTML = `
      <style>
        .chat-list {
          min-height: 220px;
          max-height: 320px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 8px;
          border: 1px solid #ddd;
          border-radius: 10px;
          padding: 10px;
          background: #fafafa;
        }
        .chat-compose {
          margin-top: 12px;
          display: flex;
          gap: 8px;
        }
        .chat-compose input {
          flex: 1;
          padding: 10px;
        }
        .chat-msg {
          border-radius: 10px;
          padding: 8px 10px;
          max-width: 85%;
        }
        .chat-msg--me {
          background: #e6f2ff;
          align-self: flex-end;
        }
        .chat-msg--peer {
          background: #f1f1f1;
          align-self: flex-start;
        }
        .chat-msg--system {
          background: #fff6e6;
          align-self: center;
          max-width: 100%;
        }
        .chat-msg__meta {
          font-size: 12px;
          color: #555;
          margin-bottom: 2px;
        }
      </style>
      <div class="card chat-card">
        <h2>Chat</h2>
        <p class="muted">Send a message. Incoming messages are pushed via callbacks.</p>

        <div id="messages" class="chat-list" aria-live="polite"></div>

        <form id="composer" class="chat-compose">
          <input
            id="messageInput"
            type="text"
            placeholder="Write a message"
            autocomplete="off"
          />
          <button id="sendBtn" type="submit">Send</button>
        </form>
      </div>
    `;
    }

    private wire(): void {
        const composer = findHtmlEl<HTMLFormElement>(this, '#composer');
        const input = findHtmlEl<HTMLInputElement>(this, '#messageInput');

        composer.addEventListener('submit', async (e) => {
            e.preventDefault();

            const text = input.value.trim();
            if (!text) return;

            this.addMessage({role: 'me', text});
            input.value = '';
            input.focus();

            try {
                await this.callbacks.onSend?.(text);
            } catch {
                this.addMessage({
                    role: 'system',
                    text: 'Failed to send message.'
                });
            }
        });
    }

    private renderMessages(): void {
        if (!this.isConnected) return;

        const list = findHtmlEl<HTMLDivElement>(this, '#messages');

        if (this.messages.length === 0) {
            list.innerHTML = `<div class="muted">No messages yet.</div>`;
            return;
        }

        list.innerHTML = this.messages
            .map((message) => {
                const roleClass = `chat-msg--${message.role}`;
                const roleLabel = message.role === 'me' ? 'You' : message.role === 'peer' ? 'Peer' : 'System';
                const text = escapeHtml(message.text);
                const time = new Date(message.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit'
                });
                return `
            <article class="chat-msg ${roleClass}">
              <header class="chat-msg__meta">${roleLabel} · ${time}</header>
              <div class="chat-msg__text">${text}</div>
            </article>
          `;
            })
            .join('');

        list.scrollTop = list.scrollHeight;
    }
}

customElements.define('chat-screen', ChatScreen);
