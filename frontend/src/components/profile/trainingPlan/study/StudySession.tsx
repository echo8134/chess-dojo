import { formatTime } from '@/board/pgn/boardTools/underboard/clock/ClockUsage';
import { TimerContext } from '@/components/timer/TimerContext';
import ScoreboardProgress from '@/scoreboard/ScoreboardProgress';
import { Check, Pause, PlayArrow } from '@mui/icons-material';
import { Button, Stack, Typography } from '@mui/material';
import { useTranslations } from 'next-intl';
import { use } from 'react';
import { StudyItem } from './book';
import { StudyTask } from './useStudy';

export interface StudySessionProps {
    task: StudyTask;
    item: StudyItem;
    currentCount: number;
    totalCount: number;
    startCount: number;
    isDone: boolean;
    onMarkDone: () => void;
}

/** The row under the board: the task's progress, the timer, and Mark game done. */
export function StudySession({
    task,
    item,
    currentCount,
    totalCount,
    startCount,
    isDone,
    onMarkDone,
}: StudySessionProps) {
    const t = useTranslations('study.session');
    const timer = use(TimerContext);
    const otherTask = timer.task && timer.task.id !== task.id;
    const runningHere = timer.isRunning && !otherTask;

    return (
        <Stack spacing={1.5} data-testid='study-session'>
            <ScoreboardProgress
                value={currentCount}
                min={startCount}
                max={totalCount}
                suffix={task.progressBarSuffix}
            />
            <Stack
                direction='row'
                sx={{
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 1,
                }}
            >
                {otherTask ? (
                    <Typography variant='body2' sx={{ color: 'text.secondary' }}>
                        {t('timerOtherTask', { name: timer.task?.name ?? '' })}
                    </Typography>
                ) : runningHere ? (
                    <Button
                        color='warning'
                        startIcon={<Pause />}
                        onClick={() => timer.onPause(task.id)}
                        data-testid='study-pause-timer'
                    >
                        {t('pauseTimer', { time: formatTime(timer.timerSeconds) })}
                    </Button>
                ) : (
                    <Button
                        color='warning'
                        startIcon={<PlayArrow />}
                        onClick={() => timer.onStart(task.id)}
                        data-testid='study-start-timer'
                    >
                        {timer.timerSeconds > 0
                            ? t('resumeTimer', { time: formatTime(timer.timerSeconds) })
                            : t('startTimer')}
                    </Button>
                )}
                <Button
                    variant='contained'
                    startIcon={<Check />}
                    onClick={onMarkDone}
                    disabled={isDone}
                    data-testid='study-mark-done'
                >
                    {isDone ? t('gameDone', { name: item.name }) : t('markGameDone')}
                </Button>
            </Stack>
        </Stack>
    );
}
