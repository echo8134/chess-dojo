'use client';

import { ChatSession, getChatHistory, sendMessage } from '@/api/chatBotApi';
import { AuthStatus, useAuth } from '@/auth/Auth';
import { ChatInput } from '@/components/help/chat/ChatInput';
import { ChatMessage } from '@/components/help/chat/ChatMessage';
import LoadingPage from '@/loading/LoadingPage';
import { logger } from '@/logging/logger';
import { Message } from '@jackstenglein/chess-dojo-common/src/chatBot/api';
import { Box, Button, CircularProgress, Container, Typography } from '@mui/material';
import { Filter } from 'bad-words';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

export function ChatPage() {
    const { user, status } = useAuth();
    if (status === AuthStatus.Loading) {
        return <LoadingPage />;
    }

    const member = status === AuthStatus.Authenticated ? user : undefined;
    return (
        <ChatConversation
            key={member ? `member:${member.username}` : 'guest'}
            kind={member ? 'member' : 'guest'}
        />
    );
}

function ChatConversation({ kind }: { kind: ChatSession['kind'] }) {
    const [session] = useState<ChatSession>(() =>
        kind === 'member' ? { kind } : { kind, token: uuidv4() },
    );
    const t = useTranslations('help.chat');
    const [messages, setMessages] = useState<Message[]>([]);
    const [isThinking, setIsThinking] = useState(false);
    const [isLoadingHistory, setIsLoadingHistory] = useState(true);
    const messagesEndRef = useRef<HTMLDivElement | null>(null);
    const requestController = useRef(new AbortController());

    const SIGNED_IN_QUESTIONS = [
        t('signedInQuestion0'),
        t('signedInQuestion1'),
        t('signedInQuestion2'),
    ];
    const SIGNED_OUT_QUESTIONS = [
        t('signedOutQuestion0'),
        t('signedOutQuestion1'),
        t('signedOutQuestion2'),
    ];

    useEffect(() => {
        if (requestController.current.signal.aborted) {
            requestController.current = new AbortController();
        }
        const controller = requestController.current;
        const { signal } = controller;
        const fetchHistory = async () => {
            try {
                const res = await getChatHistory(session, signal);
                if (!signal.aborted) setMessages(res.data.messages);
            } catch (err) {
                if (signal.aborted) return;
                logger.error?.('[ChatPage] Failed to fetch history:', err);
            } finally {
                if (!signal.aborted) setIsLoadingHistory(false);
            }
        };

        void fetchHistory();
        return () => {
            controller.abort();
        };
    }, [session]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isThinking]);

    if (isLoadingHistory) {
        return <LoadingPage />;
    }

    const handleSend = async (text: string) => {
        setMessages((prev) => [
            ...prev,
            {
                id: uuidv4(),
                role: 'user',
                content: text,
                createdAt: new Date().toISOString(),
                toolInvocations: [],
            },
        ]);

        if (new Filter().isProfane(text)) {
            setMessages((prev) => [
                ...prev,
                {
                    id: uuidv4(),
                    role: 'assistant',
                    content: t('profanityWarning'),
                    createdAt: new Date().toISOString(),
                    toolInvocations: [],
                },
            ]);
            return;
        }

        setIsThinking(true);
        const { signal } = requestController.current;

        try {
            const res = await sendMessage(session, { message: text }, signal);
            setMessages((prev) => [
                ...prev,
                {
                    id: uuidv4(),
                    role: 'assistant',
                    content: res.data.text,
                    createdAt: new Date().toISOString(),
                    toolInvocations: [],
                },
            ]);
        } catch (err) {
            if (signal.aborted) return;
            logger.error?.('[ChatPage] Send message failed:', err);
            setMessages((prev) => [
                ...prev,
                {
                    id: uuidv4(),
                    role: 'assistant',
                    content: t('errorMessage'),
                    createdAt: new Date().toISOString(),
                    toolInvocations: [],
                },
            ]);
        } finally {
            if (!signal.aborted) setIsThinking(false);
        }
    };

    const suggestedQuestions =
        session.kind === 'member' ? SIGNED_IN_QUESTIONS : SIGNED_OUT_QUESTIONS;

    return (
        <Box
            sx={{
                display: 'flex',
                flexDirection: 'column',
            }}
        >
            <Container
                maxWidth='md'
                sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    py: 2,
                }}
            >
                <Typography
                    variant='h4'
                    sx={{
                        textAlign: 'center',
                        mb: 2,
                    }}
                >
                    {t('title')}
                </Typography>
                <Typography
                    variant='body2'
                    sx={{
                        color: 'text.secondary',
                        textAlign: 'center',
                        mb: 4,
                        maxWidth: 'sm',
                        alignSelf: 'center',
                    }}
                >
                    ⚠️ {t('betaWarning')}
                </Typography>

                <Box
                    sx={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2.5,
                    }}
                >
                    {messages.length === 0 && (
                        <Box
                            sx={{
                                p: 3,
                                pb: 0,
                                display: 'flex',
                                gap: 2,
                                flexWrap: 'wrap',
                                justifyContent: 'center',
                            }}
                        >
                            {suggestedQuestions.map((question) => (
                                <Button
                                    key={question}
                                    variant='outlined'
                                    onClick={() => handleSend(question)}
                                    sx={{ borderRadius: 5, px: 3, textTransform: 'none' }}
                                >
                                    {question}
                                </Button>
                            ))}
                        </Box>
                    )}

                    {messages.map((msg) => (
                        <ChatMessage key={msg.id} message={msg} />
                    ))}

                    {isThinking && (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 1 }}>
                            <CircularProgress size={16} thickness={5} />
                            <Typography
                                variant='body2'
                                sx={{
                                    color: 'text.secondary',
                                }}
                            >
                                {t('thinking')}
                            </Typography>
                        </Box>
                    )}

                    <div ref={messagesEndRef} />
                </Box>

                <Box sx={{ pt: 1.5, pb: 2 }}>
                    <ChatInput onSend={handleSend} />
                </Box>
            </Container>
        </Box>
    );
}
