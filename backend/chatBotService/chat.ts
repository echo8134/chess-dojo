import { ChatRequestSchema, ChatResponse } from '@jackstenglein/chess-dojo-common/src/chatBot/api';
import { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from 'aws-lambda';
import axios from 'axios';
import { Filter } from 'bad-words';
import { errToApiGatewayProxyResultV2, parseEvent, success } from '../directoryService/api';
import { Conversation, guestConversation, memberConversation } from './conversation';

export const handler: APIGatewayProxyHandlerV2 = (event) => chat(event, memberConversation);

export const guestHandler: APIGatewayProxyHandlerV2 = (event) => chat(event, guestConversation);

async function chat(
    event: APIGatewayProxyEventV2,
    resolveConversation: (event: APIGatewayProxyEventV2) => Conversation,
) {
    try {
        const request = parseEvent(event, ChatRequestSchema);
        const agentResponse = await sendMessage(request.message, resolveConversation(event));
        return success(agentResponse);
    } catch (err) {
        return errToApiGatewayProxyResultV2(err);
    }
}

async function sendMessage(message: string, conversation: Conversation): Promise<ChatResponse> {
    const chatEndpoint = `${process.env.endpoint}/api/agents/${process.env.agent}/generate`;
    const cleaned = cleanedMessage(message);
    const response = await axios.post(chatEndpoint, {
        messages: [cleaned],
        threadId: conversation.threadId,
        resourceId: conversation.resourceId,
    });
    return { text: response.data.text };
}

function cleanedMessage(message: string): string {
    const customFilter = new Filter({ placeHolder: '' });
    return customFilter.clean(message);
}
