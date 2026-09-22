import { z } from 'zod';

/** Accepts message text only. The server chooses the conversation. */
export const ChatRequestSchema = z.strictObject({
    /** Message text. */
    message: z.string(),
});

/** A chat message request. */
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** The bot response. */
export interface ChatResponse {
    /** Response text. */
    text: string;
}

/** History requests accept no conversation identifiers. */
export const GetChatHistoryRequestSchema = z.strictObject({});

/** A chat history request. */
export type GetChatHistoryRequest = z.infer<typeof GetChatHistoryRequestSchema>;

/** The chat history. */
export interface GetChatHistoryResponse {
    /** Conversation messages. */
    messages: Message[];
}

/** A user or bot message. */
export interface Message {
    /** Message ID. */
    id: string;
    /** Sender role. */
    role: 'user' | 'assistant';
    /** Message text. */
    content: string;
    /** Creation date. */
    createdAt: string;
    /** Required by Mastra. Always empty. */
    toolInvocations: never[];
}
