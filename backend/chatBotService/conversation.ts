import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../directoryService/api';

export interface Conversation {
    threadId: string;
    resourceId: string;
}

const memberContextSchema = z.object({
    authorizer: z.object({
        jwt: z.object({
            claims: z.object({
                'cognito:username': z
                    .string()
                    .min(1)
                    .refine((username) => !/\s/u.test(username)),
            }),
        }),
    }),
});

const guestAuthorizationSchema = z
    .string()
    .length(43)
    .regex(/^Bearer [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

export function memberConversation(event: APIGatewayProxyEventV2): Conversation {
    const context = memberContextSchema.safeParse(event.requestContext);
    if (!context.success) {
        throw new ApiError({ statusCode: 401, publicMessage: 'Authentication required' });
    }
    const username = context.data.authorizer.jwt.claims['cognito:username'];
    return { threadId: `${username}-thread`, resourceId: username };
}

export function guestConversation(event: APIGatewayProxyEventV2): Conversation {
    const authorization = guestAuthorizationSchema.safeParse(
        event.headers.authorization ?? event.headers.Authorization,
    );
    if (!authorization.success) {
        throw new ApiError({ statusCode: 401, publicMessage: 'Guest credential required' });
    }
    const token = authorization.data.slice(7).toLowerCase();
    const digest = createHash('sha256').update(`dojoai-guest-v1\0${token}`).digest('hex');
    return { threadId: `dojoai-guest-${digest}`, resourceId: `dojoai guest ${digest}` };
}
