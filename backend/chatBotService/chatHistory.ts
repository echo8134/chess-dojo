import {
    GetChatHistoryRequestSchema,
    GetChatHistoryResponse,
} from '@jackstenglein/chess-dojo-common/src/chatBot/api';
import { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from 'aws-lambda';
import axios from 'axios';
import { errToApiGatewayProxyResultV2, parseEvent, success } from '../directoryService/api';
import { Conversation, guestConversation, memberConversation } from './conversation';

export const handler: APIGatewayProxyHandlerV2 = (event) => history(event, memberConversation);

export const guestHandler: APIGatewayProxyHandlerV2 = (event) => history(event, guestConversation);

async function history(
    event: APIGatewayProxyEventV2,
    resolveConversation: (event: APIGatewayProxyEventV2) => Conversation,
) {
    try {
        parseEvent(event, GetChatHistoryRequestSchema);
        const history = await getChatHistory(resolveConversation(event).threadId);
        return success(history);
    } catch (err) {
        return errToApiGatewayProxyResultV2(err);
    }
}

async function getChatHistory(threadId: string): Promise<GetChatHistoryResponse> {
    const historyEndpoint = `${process.env.endpoint}/api/memory/threads/${encodeURIComponent(threadId)}/messages`;
    const historyResponse = await axios.get(historyEndpoint, {
        params: { agentId: process.env.agent },
    });
    return { messages: historyResponse.data.uiMessages };
}
