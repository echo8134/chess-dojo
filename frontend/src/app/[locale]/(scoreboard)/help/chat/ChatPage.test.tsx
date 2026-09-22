import { axiosService } from '@/api/axiosService';
import { AuthStatus } from '@/auth/Auth';
import { Message } from '@jackstenglein/chess-dojo-common/src/chatBot/api';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InternalAxiosRequestConfig } from 'axios';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPage } from './ChatPage';

const auth = vi.hoisted<{ status: string; user?: { username: string } }>(() => ({
    status: 'Loading',
}));

vi.mock('@/auth/Auth', () => ({
    AuthStatus: {
        Loading: 'Loading',
        Authenticated: 'Authenticated',
        Unauthenticated: 'Unauthenticated',
    },
    useAuth: () => auth,
}));
vi.mock('@/config', () => ({ getConfig: () => ({ api: { baseUrl: 'https://api.invalid' } }) }));
vi.mock('@/analytics/events', () => ({
    EventType: { ApiRequest: 'ApiRequest' },
    trackEvent: vi.fn(),
}));
vi.mock('@/logging/logger', () => ({ logger: {} }));
const fetchAuthSession = vi.hoisted(() =>
    vi.fn(() => Promise.resolve({ tokens: { idToken: { toString: (): string => 'member-jwt' } } })),
);
vi.mock('aws-amplify/auth', () => ({ fetchAuthSession }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/components/help/SupportTicket', () => ({ default: () => null }));

interface PendingRequest {
    config: InternalAxiosRequestConfig;
    respond: (data: { messages: Message[] } | { text: string }) => void;
}

const requests: PendingRequest[] = [];
const originalAdapter = axiosService.defaults.adapter;

function message(content: string): Message {
    return {
        id: content,
        role: 'assistant',
        content,
        createdAt: '2026-09-22T00:00:00.000Z',
        toolInvocations: [],
    };
}

async function requestAt(index: number) {
    await waitFor(() => expect(requests.length).toBeGreaterThan(index));
    return requests[index];
}

async function respondHistory(index: number, content?: string) {
    const request = await requestAt(index);
    await act(async () => {
        request.respond({ messages: content ? [message(content)] : [] });
        await Promise.resolve();
    });
}

beforeEach(() => {
    auth.status = AuthStatus.Loading;
    auth.user = undefined;
    fetchAuthSession.mockReset().mockResolvedValue({
        tokens: { idToken: { toString: () => 'member-jwt' } },
    });
    requests.length = 0;
    axiosService.defaults.adapter = (config) =>
        new Promise((resolve) => {
            requests.push({
                config,
                respond: (data) =>
                    resolve({ config, data, status: 200, statusText: 'OK', headers: {} }),
            });
        });
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined);
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    axiosService.defaults.adapter = originalAdapter;
});

function deferCredentials() {
    const credentials: ((token: string) => void)[] = [];
    fetchAuthSession.mockImplementation(
        () =>
            new Promise((resolve) => {
                credentials.push((token) =>
                    resolve({ tokens: { idToken: { toString: () => token } } }),
                );
            }),
    );
    return credentials;
}

describe('chat account changes', () => {
    it('waits for the initial authentication check before loading member history', async () => {
        const { rerender } = render(<ChatPage />);
        await act(() => Promise.resolve());
        expect(requests).toHaveLength(0);
        expect(screen.getByRole('progressbar')).toBeInTheDocument();

        auth.status = AuthStatus.Authenticated;
        auth.user = { username: 'member-a' };
        rerender(<ChatPage />);
        await respondHistory(0, 'Member A history');
        expect(screen.getByText('Member A history')).toBeInTheDocument();
        expect(requests[0].config.url).toBe('/dojoai/chat');
        expect(requests[0].config.headers.get('Authorization')).toBe('Bearer member-jwt');
    });

    it('uses the same temporary guest token to load history and send messages', async () => {
        auth.status = AuthStatus.Unauthenticated;
        const { rerender, unmount } = render(<ChatPage />);
        await respondHistory(0);
        expect(screen.getByText('signedOutQuestion0')).toBeInTheDocument();
        const guestAuthorization = requests[0].config.headers.get('Authorization');
        expect(guestAuthorization).toMatch(
            /^Bearer [\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
        );

        fireEvent.change(screen.getByPlaceholderText('placeholder'), {
            target: { value: 'How should I train?' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'sendMessage' }));
        const send = await requestAt(1);
        expect(send.config.url).toBe('/public/dojoai/chat');
        expect(send.config.headers.get('Authorization')).toBe(guestAuthorization);
        expect(send.config.data).toBe('{"message":"How should I train?"}');
        await act(async () => {
            send.respond({ text: 'Study your own games.' });
            await Promise.resolve();
        });
        expect(screen.getByText('How should I train?')).toBeInTheDocument();
        expect(screen.getByText('Study your own games.')).toBeInTheDocument();
        rerender(<ChatPage />);
        expect(requests).toHaveLength(2);

        unmount();
        render(<ChatPage />);
        const newHistory = await requestAt(2);
        expect(newHistory.config.headers.get('Authorization')).not.toBe(guestAuthorization);
        await respondHistory(2);
    });

    it('renders the member history and response in the same conversation', async () => {
        auth.status = AuthStatus.Authenticated;
        auth.user = { username: 'member-a' };
        render(<ChatPage />);
        await respondHistory(0, 'Earlier member answer');
        fireEvent.change(screen.getByPlaceholderText('placeholder'), {
            target: { value: 'How do I review my games?' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'sendMessage' }));
        const send = await requestAt(1);
        expect(send.config.url).toBe('/dojoai/chat');
        expect(send.config.headers.get('Authorization')).toBe('Bearer member-jwt');
        expect(send.config.data).toBe('{"message":"How do I review my games?"}');
        await act(async () => {
            send.respond({ text: 'Start with your own analysis.' });
            await Promise.resolve();
        });
        expect(screen.getByText('Earlier member answer')).toBeInTheDocument();
        expect(screen.getByText('How do I review my games?')).toBeInTheDocument();
        expect(screen.getByText('Start with your own analysis.')).toBeInTheDocument();
    });

    it('clears messages when switching accounts or signing out', async () => {
        auth.status = AuthStatus.Authenticated;
        auth.user = { username: 'member-a' };
        const { rerender } = render(<ChatPage />);
        await respondHistory(0, 'Member A history');

        auth.user = { username: 'member-b' };
        rerender(<ChatPage />);
        expect(screen.queryByText('Member A history')).not.toBeInTheDocument();
        await respondHistory(1, 'Member B history');
        expect(screen.getByText('Member B history')).toBeInTheDocument();

        auth.status = AuthStatus.Unauthenticated;
        auth.user = undefined;
        rerender(<ChatPage />);
        expect(screen.queryByText('Member B history')).not.toBeInTheDocument();
        await respondHistory(2);
        expect(requests[2].config.url).toBe('/public/dojoai/chat');
        expect(screen.getByText('signedOutQuestion0')).toBeInTheDocument();
    });

    it('clears member history when authentication fails but the user object remains', async () => {
        auth.status = AuthStatus.Authenticated;
        auth.user = { username: 'member-a' };
        const { rerender } = render(<ChatPage />);
        await respondHistory(0, 'Private member history');
        expect(screen.getByText('Private member history')).toBeInTheDocument();

        auth.status = AuthStatus.Unauthenticated;
        rerender(<ChatPage />);
        expect(screen.queryByText('Private member history')).not.toBeInTheDocument();
        await respondHistory(1);
        expect(requests[1].config.url).toBe('/public/dojoai/chat');
        expect(requests[1].config.headers.get('Authorization')).toMatch(
            /^Bearer [\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
        );
        expect(screen.getByText('signedOutQuestion0')).toBeInTheDocument();
    });

    it('ignores history that arrives after the identity changes', async () => {
        auth.status = AuthStatus.Unauthenticated;
        const { rerender } = render(<ChatPage />);
        await requestAt(0);

        auth.status = AuthStatus.Authenticated;
        auth.user = { username: 'member-a' };
        rerender(<ChatPage />);
        await respondHistory(1, 'Member A history');
        await respondHistory(0, 'Late guest history');
        expect(screen.getByText('Member A history')).toBeInTheDocument();
        expect(screen.queryByText('Late guest history')).not.toBeInTheDocument();
    });

    it('keeps a previous member reply out of the new member conversation', async () => {
        auth.status = AuthStatus.Authenticated;
        auth.user = { username: 'member-a' };
        const { rerender } = render(<ChatPage />);
        await respondHistory(0);
        fireEvent.click(screen.getByRole('button', { name: 'signedInQuestion0' }));
        const oldSend = await requestAt(1);
        expect(oldSend.config.url).toBe('/dojoai/chat');
        expect(oldSend.config.headers.get('Authorization')).toBe('Bearer member-jwt');
        expect(oldSend.config.data).toBe('{"message":"signedInQuestion0"}');

        auth.user = { username: 'member-b' };
        rerender(<ChatPage />);
        await respondHistory(2, 'Member B history');
        await act(async () => {
            oldSend.respond({ text: 'Late member A reply' });
            await Promise.resolve();
        });
        expect(screen.getByText('Member B history')).toBeInTheDocument();
        expect(screen.queryByText('Late member A reply')).not.toBeInTheDocument();
        expect(screen.queryByText('thinking')).not.toBeInTheDocument();
    });

    it('cancels a pending message before it can use another account token', async () => {
        const credentials = deferCredentials();
        auth.status = AuthStatus.Authenticated;
        auth.user = { username: 'member-a' };
        const { rerender } = render(<ChatPage />);
        await waitFor(() => expect(credentials).toHaveLength(1));
        await act(async () => {
            credentials[0]('jwt-member-a');
            await Promise.resolve();
        });
        await respondHistory(0);
        fireEvent.change(screen.getByPlaceholderText('placeholder'), {
            target: { value: 'Private member A prompt' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'sendMessage' }));
        await waitFor(() => expect(credentials).toHaveLength(2));

        auth.user = { username: 'member-b' };
        rerender(<ChatPage />);
        await waitFor(() => expect(credentials).toHaveLength(3));
        await act(async () => {
            credentials[1]('jwt-member-b');
            credentials[2]('jwt-member-b');
            await Promise.resolve();
        });
        expect(requests.map(({ config }) => config.method)).toEqual(['get', 'get']);
        await respondHistory(1, 'Member B history');
        expect(screen.queryByText('Private member A prompt')).not.toBeInTheDocument();
        expect(screen.queryByText('errorMessage')).not.toBeInTheDocument();

        fireEvent.change(screen.getByPlaceholderText('placeholder'), {
            target: { value: 'Member B question' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'sendMessage' }));
        await waitFor(() => expect(credentials).toHaveLength(4));
        await act(async () => {
            credentials[3]('jwt-member-b');
            await Promise.resolve();
        });
        const send = await requestAt(2);
        expect(send.config.data).toBe('{"message":"Member B question"}');
        expect(send.config.headers.get('Authorization')).toBe('Bearer jwt-member-b');
        await act(async () => {
            send.respond({ text: 'Member B answer' });
            await Promise.resolve();
        });
        expect(screen.getByText('Member B answer')).toBeInTheDocument();
    });

    it('cancels a pending history request before it can use another account token', async () => {
        const credentials = deferCredentials();
        auth.status = AuthStatus.Authenticated;
        auth.user = { username: 'member-a' };
        const { rerender } = render(<ChatPage />);
        await waitFor(() => expect(credentials).toHaveLength(1));
        auth.user = { username: 'member-b' };
        rerender(<ChatPage />);
        await waitFor(() => expect(credentials).toHaveLength(2));
        await act(async () => {
            credentials[0]('jwt-member-b');
            credentials[1]('jwt-member-b');
            await Promise.resolve();
        });
        expect(requests).toHaveLength(1);
        await respondHistory(0, 'Member B history');
        expect(screen.getByText('Member B history')).toBeInTheDocument();
    });

    it('loads history and sends after StrictMode replays the conversation effect', async () => {
        auth.status = AuthStatus.Authenticated;
        auth.user = { username: 'member-a' };
        render(
            <StrictMode>
                <ChatPage />
            </StrictMode>,
        );
        await respondHistory(0);
        expect(requests).toHaveLength(1);
        fireEvent.click(screen.getByRole('button', { name: 'signedInQuestion0' }));
        const send = await requestAt(1);
        await act(async () => {
            send.respond({ text: 'StrictMode answer' });
            await Promise.resolve();
        });
        expect(screen.getByText('StrictMode answer')).toBeInTheDocument();
        expect(screen.queryByText('errorMessage')).not.toBeInTheDocument();
    });
});
