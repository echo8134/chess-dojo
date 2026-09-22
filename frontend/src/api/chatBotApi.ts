import {
    ChatRequest,
    ChatResponse,
    GetChatHistoryResponse,
} from '@jackstenglein/chess-dojo-common/src/chatBot/api';
import { AxiosResponse } from 'axios';
import { axiosService } from './axiosService';

export type ChatSession = { kind: 'member' } | { kind: 'guest'; token: string };

export async function sendMessage(
    session: ChatSession,
    request: ChatRequest,
    signal?: AbortSignal,
): Promise<AxiosResponse<ChatResponse>> {
    return await axiosService.post(
        session.kind === 'member' ? '/dojoai/chat' : '/public/dojoai/chat',
        request,
        {
            headers:
                session.kind === 'guest' ? { Authorization: `Bearer ${session.token}` } : undefined,
            functionName: 'sendMessage',
            signal,
        },
    );
}

export async function getChatHistory(
    session: ChatSession,
    signal?: AbortSignal,
): Promise<AxiosResponse<GetChatHistoryResponse>> {
    return await axiosService.get(
        session.kind === 'member' ? '/dojoai/chat' : '/public/dojoai/chat',
        {
            headers:
                session.kind === 'guest' ? { Authorization: `Bearer ${session.token}` } : undefined,
            functionName: 'getChatHistory',
            signal,
        },
    );
}
