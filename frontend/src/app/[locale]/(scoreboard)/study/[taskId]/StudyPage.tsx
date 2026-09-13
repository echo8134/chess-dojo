'use client';

import { RequestSnackbar } from '@/api/Request';
import PurchaseCoursePage from '@/app/[locale]/(scoreboard)/courses/[type]/[id]/[chapter]/[module]/PurchaseCoursePage';
import { useAuth, useFreeTier } from '@/auth/Auth';
import PgnBoard from '@/board/pgn/PgnBoard';
import { DefaultUnderboardTab } from '@/board/pgn/boardTools/underboard/underboardTabs';
import { Link } from '@/components/navigation/Link';
import { TimelineProvider } from '@/components/profile/activity/useTimeline';
import { ProgressUpdater } from '@/components/profile/trainingPlan/ProgressUpdater';
import { StudyBrowseNotice } from '@/components/profile/trainingPlan/study/StudyBrowseNotice';
import { StudyCatalog } from '@/components/profile/trainingPlan/study/StudyCatalog';
import { StudyLayout } from '@/components/profile/trainingPlan/study/StudyLayout';
import { StudySession } from '@/components/profile/trainingPlan/study/StudySession';
import {
    StudyReady,
    StudySource,
    useStudy,
} from '@/components/profile/trainingPlan/study/useStudy';
import { GameContext } from '@/context/useGame';
import { useNextSearchParams } from '@/hooks/useNextSearchParams';
import LoadingPage from '@/loading/LoadingPage';
import {
    Button,
    Container,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Stack,
    Typography,
} from '@mui/material';
import { useTranslations } from 'next-intl';
import { useNavigationGuard } from 'next-navigation-guard';
import { useEffect, useState } from 'react';

const STUDY_TABS = [
    DefaultUnderboardTab.Tags,
    DefaultUnderboardTab.Editor,
    DefaultUnderboardTab.Comments,
    DefaultUnderboardTab.Explorer,
    DefaultUnderboardTab.Clocks,
    DefaultUnderboardTab.Share,
    DefaultUnderboardTab.Settings,
];

const NO_DONE_MARKS = new Set<string>();

export function StudyPage({ source }: { source: StudySource }) {
    const { user } = useAuth();
    if (!user) {
        return <LoadingPage />;
    }
    // The provider loads a year of history on mount, which only the progress updater needs.
    if (source.kind !== 'task') {
        return <StudyContent source={source} />;
    }
    return (
        <TimelineProvider owner={user.username}>
            <StudyContent source={source} />
        </TimelineProvider>
    );
}

function StudyContent({ source }: { source: StudySource }) {
    const t = useTranslations('study');
    const { searchParams } = useNextSearchParams();
    const study = useStudy(source, searchParams.get('item'));
    const isFreeTier = useFreeTier();

    if (study.status === 'loading') {
        return <LoadingPage />;
    }
    if (study.status === 'error') {
        return (
            <Container sx={{ py: 5 }}>
                <Typography color='error'>{String(study.error)}</Typography>
            </Container>
        );
    }
    if (study.status === 'blocked') {
        return <PurchaseCoursePage course={study.course} isFreeTier={isFreeTier} />;
    }
    if (study.status === 'no-material' || study.status === 'empty') {
        return (
            <Container sx={{ py: 5 }}>
                <Stack spacing={2}>
                    <Typography variant='h5'>
                        {study.status === 'no-material' ? study.task.name : study.book.title}
                    </Typography>
                    <Typography>
                        {study.status === 'no-material'
                            ? t('noMaterial')
                            : t('catalog.empty', { count: study.book.skipped })}
                    </Typography>
                    <Button
                        component={Link}
                        href='/profile?view=progress'
                        sx={{ alignSelf: 'flex-start' }}
                    >
                        {t('backToPlan')}
                    </Button>
                </Stack>
            </Container>
        );
    }
    return <StudyReadyView study={study} />;
}

function StudyReadyView({ study }: { study: StudyReady }) {
    const t = useTranslations('study');
    const tGuard = useTranslations('games.unsavedNavigationGuard');
    const [markingDone, setMarkingDone] = useState(false);
    const [blockedSelect, setBlockedSelect] = useState(false);

    // The board's own guard only covers a saved game; until the copy exists, this page holds the edits.
    const guard = useNavigationGuard({ enabled: study.pendingEdits });
    useEffect(() => {
        if (!study.pendingEdits) return;
        const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [study.pendingEdits]);

    const { session, book, current, board } = study;
    const isDone = session?.done.has(current.key) ?? false;

    return (
        <>
            <StudyLayout
                breadcrumb={
                    <Typography
                        variant='body2'
                        sx={{ color: 'text.secondary' }}
                        data-testid='study-breadcrumb'
                    >
                        {session
                            ? `${session.task.category} / ${session.task.name} · ${session.currentCount} / ${session.totalCount}`
                            : t('browse.breadcrumb', { title: book.title })}
                    </Typography>
                }
                catalog={
                    <StudyCatalog
                        book={book}
                        current={current}
                        done={session?.done ?? NO_DONE_MARKS}
                        workedOn={study.workedOn}
                        historyComplete={session?.historyComplete ?? true}
                        browsing={!session}
                        onSelect={(item) => {
                            if (!study.select(item)) setBlockedSelect(true);
                        }}
                    />
                }
                board={
                    board ? (
                        <GameContext.Provider value={board.context}>
                            {board.context.game && current.kind === 'canonical' && (
                                <Typography
                                    variant='caption'
                                    sx={{ color: 'dojoOrange.main' }}
                                    data-testid='study-your-copy'
                                >
                                    {t('yourCopy')}
                                </Typography>
                            )}
                            <PgnBoard
                                key={board.key}
                                pgn={board.pgn}
                                startOrientation={board.orientation}
                                onInitialize={study.onBoardInitialize}
                                disableExport={board.disableExport}
                                underboardTabs={STUDY_TABS}
                                initialUnderboardTab={DefaultUnderboardTab.Editor}
                                allowMoveDeletion
                                allowDeleteBefore
                            />
                        </GameContext.Provider>
                    ) : (
                        <LoadingPage />
                    )
                }
                session={
                    session ? (
                        <StudySession
                            task={session.task}
                            item={current}
                            currentCount={session.currentCount}
                            totalCount={session.totalCount}
                            startCount={session.task.startCount ?? 0}
                            isDone={isDone}
                            onMarkDone={() => setMarkingDone(true)}
                        />
                    ) : (
                        <StudyBrowseNotice />
                    )
                }
            />

            <RequestSnackbar request={study.copyRequest} />

            {session && (
                <Dialog
                    open={markingDone}
                    onClose={() => setMarkingDone(false)}
                    maxWidth='md'
                    fullWidth
                >
                    <DialogTitle>{t('session.markDoneTitle', { name: current.name })}</DialogTitle>
                    <ProgressUpdater
                        requirement={session.task}
                        progress={session.progress}
                        cohort={session.cohort}
                        initialCount={Math.min(session.currentCount + 1, session.totalCount)}
                        studyInfo={{ itemKey: current.key, itemName: current.name }}
                        onSuccess={session.onMarkedDone}
                        onClose={() => setMarkingDone(false)}
                    />
                </Dialog>
            )}

            <Dialog open={blockedSelect} onClose={() => setBlockedSelect(false)}>
                <DialogTitle>{t('session.savingTitle')}</DialogTitle>
                <DialogContent>
                    {study.copyRequest.isFailure()
                        ? t('session.unsavedBody')
                        : t('session.savingBody')}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setBlockedSelect(false)}>{tGuard('cancel')}</Button>
                </DialogActions>
            </Dialog>

            <Dialog open={guard.active} onClose={guard.reject}>
                <DialogTitle>{tGuard('title')}</DialogTitle>
                <DialogContent>{tGuard('gameWarning')}</DialogContent>
                <DialogActions>
                    <Button onClick={guard.reject}>{tGuard('cancel')}</Button>
                    <Button color='error' onClick={guard.accept}>
                        {tGuard('leave')}
                    </Button>
                </DialogActions>
            </Dialog>
        </>
    );
}
