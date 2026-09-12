'use client';

import { RequestSnackbar } from '@/api/Request';
import PurchaseCoursePage from '@/app/[locale]/(scoreboard)/courses/[type]/[id]/[chapter]/[module]/PurchaseCoursePage';
import { useAuth, useFreeTier } from '@/auth/Auth';
import PgnBoard from '@/board/pgn/PgnBoard';
import { DefaultUnderboardTab } from '@/board/pgn/boardTools/underboard/underboardTabs';
import { Link } from '@/components/navigation/Link';
import { TimelineProvider } from '@/components/profile/activity/useTimeline';
import { ProgressUpdater } from '@/components/profile/trainingPlan/ProgressUpdater';
import { StudyCatalog } from '@/components/profile/trainingPlan/study/StudyCatalog';
import { StudyLayout } from '@/components/profile/trainingPlan/study/StudyLayout';
import { StudySession } from '@/components/profile/trainingPlan/study/StudySession';
import { StudyReady, useStudy } from '@/components/profile/trainingPlan/study/useStudy';
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

export function StudyPage({ taskId }: { taskId: string }) {
    const { user } = useAuth();
    if (!user) {
        return <LoadingPage />;
    }
    return (
        <TimelineProvider owner={user.username}>
            <StudyContent taskId={taskId} />
        </TimelineProvider>
    );
}

function StudyContent({ taskId }: { taskId: string }) {
    const t = useTranslations('study');
    const { searchParams } = useNextSearchParams();
    const study = useStudy(taskId, searchParams.get('item'));
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
                    <Typography variant='h5'>{study.task.name}</Typography>
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

    const { task, book, current, board } = study;
    const isDone = study.done.has(current.key);

    return (
        <>
            <StudyLayout
                breadcrumb={
                    <Typography
                        variant='body2'
                        sx={{ color: 'text.secondary' }}
                        data-testid='study-breadcrumb'
                    >
                        {task.category} / {task.name} · {study.currentCount} / {study.totalCount}
                    </Typography>
                }
                catalog={
                    <StudyCatalog
                        book={book}
                        current={current}
                        done={study.done}
                        workedOn={study.workedOn}
                        historyComplete={study.historyComplete}
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
                    <StudySession
                        task={task}
                        item={current}
                        currentCount={study.currentCount}
                        totalCount={study.totalCount}
                        startCount={task.startCount ?? 0}
                        isDone={isDone}
                        onMarkDone={() => setMarkingDone(true)}
                    />
                }
            />

            <RequestSnackbar request={study.copyRequest} />

            <Dialog
                open={markingDone}
                onClose={() => setMarkingDone(false)}
                maxWidth='md'
                fullWidth
            >
                <DialogTitle>{t('session.markDoneTitle', { name: current.name })}</DialogTitle>
                <ProgressUpdater
                    requirement={task}
                    progress={study.progress}
                    cohort={study.cohort}
                    initialCount={Math.min(study.currentCount + 1, study.totalCount)}
                    studyInfo={{ itemKey: current.key, itemName: current.name }}
                    onSuccess={study.onMarkedDone}
                    onClose={() => setMarkingDone(false)}
                />
            </Dialog>

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
