import { fetchAuthSession } from 'aws-amplify/auth';
import { AxiosAdapter } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axiosService } from './axiosService';
import { ChatSession, getChatHistory, sendMessage } from './chatBotApi';

vi.mock('@/config', () => ({ getConfig: () => ({ api: { baseUrl: 'https://api.invalid' } }) }));
vi.mock('@/analytics/events', () => ({
    EventType: { ApiRequest: 'ApiRequest' },
    trackEvent: vi.fn(),
}));
vi.mock('@/logging/logger', () => ({ logger: {} }));
vi.mock('aws-amplify/auth', () => ({
    fetchAuthSession: vi.fn(() =>
        Promise.resolve({
            tokens: { idToken: { toString: () => 'member-jwt' } },
        }),
    ),
}));

const originalAdapter = axiosService.defaults.adapter;
const adapter = vi.fn<AxiosAdapter>((config) =>
    Promise.resolve({
        config,
        data: config.method === 'get' ? { messages: [] } : { text: 'Your own response' },
        status: 200,
        statusText: 'OK',
        headers: {},
    }),
);

beforeEach(() => {
    vi.clearAllMocks();
    axiosService.defaults.adapter = adapter;
});

afterEach(() => {
    axiosService.defaults.adapter = originalAdapter;
});

describe('chat authorization', () => {
    it.each([
        {
            session: { kind: 'member' } satisfies ChatSession,
            route: '/dojoai/chat',
            authorization: 'Bearer member-jwt',
            authenticated: true,
        },
        {
            session: {
                kind: 'guest',
                token: 'd8c87c47-bb21-4abe-ae21-d1c6e3b557ac',
            } satisfies ChatSession,
            route: '/public/dojoai/chat',
            authorization: 'Bearer d8c87c47-bb21-4abe-ae21-d1c6e3b557ac',
            authenticated: false,
        },
    ])(
        'sends $session.kind requests with credentials and no conversation IDs',
        async ({ session, route, authorization, authenticated }) => {
            expect((await getChatHistory(session)).data).toEqual({ messages: [] });
            expect((await sendMessage(session, { message: 'How should I study?' })).data).toEqual({
                text: 'Your own response',
            });

            expect(adapter).toHaveBeenCalledTimes(2);
            const [history, send] = adapter.mock.calls.map(([config]) => config);
            expect(history.url).toBe(route);
            expect(history.method).toBe('get');
            expect(history.params).toBeUndefined();
            expect(history.data).toBeUndefined();
            expect(send.url).toBe(route);
            expect(send.method).toBe('post');
            expect(send.data).toBe('{"message":"How should I study?"}');
            expect(history.headers.get('Authorization')).toBe(authorization);
            expect(send.headers.get('Authorization')).toBe(authorization);
            expect(fetchAuthSession).toHaveBeenCalledTimes(authenticated ? 2 : 0);
        },
    );
});
