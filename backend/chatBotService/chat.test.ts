import {
    APIGatewayProxyEventV2,
    APIGatewayProxyEventV2WithJWTAuthorizer,
    Context,
} from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({ default: { get, post } }));

import { handler as chat, guestHandler as guestChat } from './chat';
import { guestHandler as guestHistory, handler as history } from './chatHistory';

const context: Context = {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'synthetic-chat',
    functionVersion: '1',
    invokedFunctionArn: 'synthetic',
    memoryLimitInMB: '128',
    awsRequestId: 'synthetic',
    logGroupName: 'synthetic',
    logStreamName: 'synthetic',
    getRemainingTimeInMillis: () => 1000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
};

function publicEvent(method: string): APIGatewayProxyEventV2 {
    return {
        version: '2.0',
        routeKey: `${method} /public/dojoai/chat`,
        rawPath: '/public/dojoai/chat',
        rawQueryString: '',
        headers: {},
        isBase64Encoded: false,
        requestContext: {
            accountId: 'synthetic',
            apiId: 'synthetic',
            domainName: 'synthetic.invalid',
            domainPrefix: 'synthetic',
            http: {
                method,
                path: '/public/dojoai/chat',
                protocol: 'HTTP/1.1',
                sourceIp: '127.0.0.1',
                userAgent: 'synthetic',
            },
            requestId: 'synthetic',
            routeKey: `${method} /public/dojoai/chat`,
            stage: 'test',
            time: 'synthetic',
            timeEpoch: 0,
        },
    };
}

const guestToken = 'a1b2c3d4-5678-4abc-9def-0123456789ab';
const guestDigest = '35ddff2e1e4441e5790b3a067e897958bdcf3538e2e72b9e15ea5d7a1b547735';

function memberEvent(
    method: string,
    username: string | number | boolean,
): APIGatewayProxyEventV2WithJWTAuthorizer {
    const event = publicEvent(method);
    return {
        ...event,
        rawPath: '/dojoai/chat',
        requestContext: {
            ...event.requestContext,
            authorizer: {
                principalId: 'synthetic',
                integrationLatency: 0,
                jwt: { claims: { 'cognito:username': username }, scopes: [] },
            },
        },
    };
}

function guestEvent(method: string, token = guestToken): APIGatewayProxyEventV2 {
    const event = publicEvent(method);
    event.headers.authorization = `Bearer ${token}`;
    return event;
}

describe('DojoAI conversation authorization', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('endpoint', 'https://synthetic.invalid');
        vi.stubEnv('agent', 'synthetic-agent');
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        get.mockResolvedValue({
            data: { uiMessages: [{ content: 'Synthetic member private history' }] },
        });
        post.mockResolvedValue({ data: { text: 'Synthetic agent reply' } });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('rejects anonymous reads of member history', async () => {
        const event = publicEvent('GET');
        event.queryStringParameters = { threadId: 'synthetic-member-thread' };
        const result = await guestHistory(event, context, () => {});
        expect(result).toMatchObject({ statusCode: 400 });
        expect(get).not.toHaveBeenCalled();
    });

    it('rejects anonymous writes with forged member identifiers', async () => {
        const event = publicEvent('POST');
        event.body = JSON.stringify({
            message: 'Synthetic unauthorized addition',
            threadId: 'synthetic-member-thread',
            resourceId: 'synthetic-member',
        });
        const result = await guestChat(event, context, () => {});
        expect(result).toMatchObject({ statusCode: 400 });
        expect(post).not.toHaveBeenCalled();
    });

    it.each([chat, history])('requires verified member claims', async (handler) => {
        const event = publicEvent('POST');
        if (handler === chat) event.body = JSON.stringify({ message: 'Hello' });
        expect(await handler(event, context, () => {})).toMatchObject({ statusCode: 401 });
        expect(get).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    it.each(['', ' ', 'member name', 'member\nname', 'member\n', true, 42])(
        'rejects invalid member claim %j',
        async (username) => {
            const event = memberEvent('GET', username);
            expect(await history(event, context, () => {})).toMatchObject({ statusCode: 401 });
            event.body = JSON.stringify({ message: 'Hello' });
            expect(await chat(event, context, () => {})).toMatchObject({ statusCode: 401 });
            expect(get).not.toHaveBeenCalled();
            expect(post).not.toHaveBeenCalled();
        },
    );

    it('reads and writes only the authenticated member conversation', async () => {
        const event = memberEvent('GET', 'synthetic-member');
        expect(await history(event, context, () => {})).toMatchObject({
            statusCode: 200,
            body: JSON.stringify({ messages: [{ content: 'Synthetic member private history' }] }),
        });
        expect(get).toHaveBeenCalledExactlyOnceWith(
            'https://synthetic.invalid/api/memory/threads/synthetic-member-thread/messages',
            {
                params: { agentId: 'synthetic-agent' },
            },
        );
        event.body = JSON.stringify({ message: 'Hello' });
        expect(await chat(event, context, () => {})).toMatchObject({
            statusCode: 200,
            body: JSON.stringify({ text: 'Synthetic agent reply' }),
        });
        expect(post).toHaveBeenCalledExactlyOnceWith(
            'https://synthetic.invalid/api/agents/synthetic-agent/generate',
            {
                messages: ['Hello'],
                threadId: 'synthetic-member-thread',
                resourceId: 'synthetic-member',
            },
        );
    });

    it.each(['body', 'query'])('rejects member selectors in the %s', async (location) => {
        const event = memberEvent('GET', 'attacker');
        const selectors = { threadId: 'victim-thread', resourceId: 'victim' };
        if (location === 'body') event.body = JSON.stringify(selectors);
        else event.queryStringParameters = selectors;
        expect(await history(event, context, () => {})).toMatchObject({ statusCode: 400 });
        event.body = JSON.stringify(
            location === 'body' ? { message: 'Hello', ...selectors } : { message: 'Hello' },
        );
        expect(await chat(event, context, () => {})).toMatchObject({ statusCode: 400 });
        expect(get).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    it.each([
        undefined,
        '',
        'Bearer null',
        'Bearer ../../member',
        `Basic ${guestToken}`,
        'Bearer a1b2c3d4-5678-1abc-9def-0123456789ab',
        `Bearer ${guestToken} extra`,
        `Bearer ${guestToken}\n`,
    ])('rejects invalid guest credentials %j', async (authorization) => {
        const event = publicEvent('GET');
        event.headers.authorization = authorization;
        expect(await guestHistory(event, context, () => {})).toMatchObject({ statusCode: 401 });
        event.body = JSON.stringify({ message: 'Hello' });
        expect(await guestChat(event, context, () => {})).toMatchObject({ statusCode: 401 });
        expect(get).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    it('separates guest and member conversations with the same UUID', async () => {
        const guest = guestEvent('GET');
        get.mockResolvedValue({ data: { uiMessages: [{ content: 'Synthetic guest history' }] } });
        expect(await guestHistory(guest, context, () => {})).toMatchObject({
            statusCode: 200,
            body: JSON.stringify({ messages: [{ content: 'Synthetic guest history' }] }),
        });
        expect(get).toHaveBeenLastCalledWith(
            `https://synthetic.invalid/api/memory/threads/dojoai-guest-${guestDigest}/messages`,
            { params: { agentId: 'synthetic-agent' } },
        );
        guest.body = JSON.stringify({ message: 'Hello' });
        expect(await guestChat(guest, context, () => {})).toMatchObject({
            statusCode: 200,
            body: JSON.stringify({ text: 'Synthetic agent reply' }),
        });
        expect(post).toHaveBeenLastCalledWith(
            'https://synthetic.invalid/api/agents/synthetic-agent/generate',
            {
                messages: ['Hello'],
                threadId: `dojoai-guest-${guestDigest}`,
                resourceId: `dojoai guest ${guestDigest}`,
            },
        );
        const member = memberEvent('POST', guestToken);
        member.body = JSON.stringify({ message: 'Member message' });
        expect(await chat(member, context, () => {})).toMatchObject({ statusCode: 200 });
        expect(post).toHaveBeenLastCalledWith(
            'https://synthetic.invalid/api/agents/synthetic-agent/generate',
            {
                messages: ['Member message'],
                threadId: `${guestToken}-thread`,
                resourceId: guestToken,
            },
        );
    });

    it('ignores member claims on guest routes and accepts uppercase guest tokens', async () => {
        const event = memberEvent('GET', 'victim');
        event.headers.Authorization = `bEaReR ${guestToken.toUpperCase()}`;
        expect(await guestHistory(event, context, () => {})).toMatchObject({ statusCode: 200 });
        expect(get).toHaveBeenLastCalledWith(
            `https://synthetic.invalid/api/memory/threads/dojoai-guest-${guestDigest}/messages`,
            { params: { agentId: 'synthetic-agent' } },
        );
        event.body = JSON.stringify({ message: 'Hello' });
        expect(await guestChat(event, context, () => {})).toMatchObject({ statusCode: 200 });
        expect(post).toHaveBeenLastCalledWith(
            'https://synthetic.invalid/api/agents/synthetic-agent/generate',
            {
                messages: ['Hello'],
                threadId: `dojoai-guest-${guestDigest}`,
                resourceId: `dojoai guest ${guestDigest}`,
            },
        );
    });

    it('isolates distinct guest credentials', async () => {
        const event = guestEvent('GET', 'b1b2c3d4-5678-4abc-9def-0123456789ab');
        expect(await guestHistory(event, context, () => {})).toMatchObject({ statusCode: 200 });
        expect(get).toHaveBeenLastCalledWith(
            'https://synthetic.invalid/api/memory/threads/dojoai-guest-87ac15c619dd1d4932b903f7c7feb64fd555a3149bd918b257e5d8692307fde6/messages',
            { params: { agentId: 'synthetic-agent' } },
        );
    });

    it('encodes member usernames as a single upstream path segment', async () => {
        const event = memberEvent('GET', 'member/name?#suffix');
        expect(await history(event, context, () => {})).toMatchObject({ statusCode: 200 });
        expect(get).toHaveBeenCalledExactlyOnceWith(
            'https://synthetic.invalid/api/memory/threads/member%2Fname%3F%23suffix-thread/messages',
            { params: { agentId: 'synthetic-agent' } },
        );
    });
});
