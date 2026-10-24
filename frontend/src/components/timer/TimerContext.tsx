'use client';

import { useApi } from '@/api/Api';
import { useRequirement } from '@/api/cache/requirements';
import { useAuth } from '@/auth/Auth';
import { formatTime } from '@/board/pgn/boardTools/underboard/clock/ClockUsage';
import { CustomTask, Requirement } from '@/database/requirement';
import { useTranslations } from 'next-intl';
import { createContext, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    CHECK_IN_MS,
    checkIn,
    clear,
    Clock,
    clockFrom,
    elapsedSeconds,
    isExpired,
    pause,
    restart,
    sameClock,
    start,
    toUserFields,
} from './clock';

/** Regex which matches the timer in the title of the page */
const TIMER_TITLE_REGEX = /^[\d:]+ - /;

/**
 * The work timer's state and controls. The value changes when the run state, the task or the
 * task dialog changes, not on the tick, so a consumer can hold it without re-rendering each second.
 */
export interface TimerControls {
    isRunning: boolean;
    isPaused: boolean;
    task?: Requirement | CustomTask;
    showTask: boolean;
    setShowTask: (v: boolean) => void;
    onStart: (taskId?: string) => void;
    onPause: (taskId?: string, showDialog?: boolean) => void;
    onToggle: (taskId?: string) => void;
    onClear: () => void;
    /**
     * Starts the timer for the task from the given seconds, zero by default, in one write. Logs
     * nothing itself.
     */
    onRestart: (taskId: string, seconds?: number) => void;
    /** Writes the clock as given, in one write. */
    setClock: (next: Clock) => void;
    /** The clock as the latest user record holds it. */
    getClock: () => Clock;
    /** The seconds on the clock at the moment of the call. */
    getSeconds: () => number;
}

/** The details of the work timer, with the seconds that tick while it runs. */
export interface Timer extends TimerControls {
    timerSeconds: number;
    /** The label of the control for the task, from the seconds as rendered. */
    getLabel: (taskId?: string) => string;
}

export const TimerControlsContext = createContext<TimerControls>(null as unknown as TimerControls);
export const TimerContext = createContext<Timer>(null as unknown as Timer);

/**
 * Renders a provider for the timer context to allow syncing timer details
 * between different components.
 */
export function TimerContextProvider({ children }: { children: ReactNode }) {
    const t = useTranslations('timer');
    const { user, updateUser } = useAuth();
    const api = useApi();
    const [now, setNow] = useState(() => Date.now());
    const [showTask, setShowTask] = useState(false);
    const { requirement } = useRequirement(user?.timerTaskId);
    const customTask = user?.customTasks?.find((ct) => ct.id === user.timerTaskId);
    const task = customTask || requirement;

    const clock = clockFrom(user);
    const expired = clock.kind === 'running' && isExpired(clock, now);
    const isRunning = clock.kind === 'running' && !expired;
    // An expired clock reads as paused until its repair lands, so the navbar does not flicker.
    const isPaused = (clock.kind === 'paused' && clock.seconds > 0) || expired;
    const timerSeconds = elapsedSeconds(clock, now);
    const since = clock.kind === 'running' ? clock.since : undefined;

    // The ops keep one identity across renders and read the committed render here.
    const latest = useRef({ clock, isRunning, task, api });
    useEffect(() => {
        latest.current = { clock, isRunning, task, api };
    });

    const ops = useMemo(() => {
        const getClock = () => latest.current.clock;
        const write = (next: Clock) => {
            const fields = toUserFields(next);
            setNow(Date.now());
            updateUser(fields);
            void latest.current.api.updateUser(fields);
        };
        const onOtherTask = (taskId?: string) => {
            const clock = getClock();
            return clock.kind !== 'idle' && !!clock.taskId && taskId !== clock.taskId;
        };
        const onStart = (taskId?: string) => write(start(getClock(), taskId, Date.now()));
        const onPause = (taskId?: string, openDialog?: boolean) => {
            write(pause(getClock(), Date.now(), taskId));
            if (openDialog && latest.current.task) {
                setShowTask(true);
            }
        };
        return {
            onStart,
            onPause,
            onToggle: (taskId?: string) => {
                if (!onOtherTask(taskId) && latest.current.isRunning) {
                    onPause(taskId, true);
                } else {
                    onStart(taskId);
                }
            },
            onClear: () => write(clear()),
            onRestart: (taskId: string, seconds = 0) => write(restart(taskId, seconds, Date.now())),
            setClock: write,
            getClock,
            getSeconds: () => elapsedSeconds(getClock(), Date.now()),
        };
    }, [updateUser]);

    // Banks the stretch so far, after adopting the server's copy. Otherwise this tab would write
    // "running" over a pause, clear or task switch made in another tab.
    const renew = useCallback(async () => {
        const before = ops.getClock();
        const fetched = await latest.current.api.getUser().catch(() => undefined);
        if (!fetched) {
            return;
        }
        // The member acted while the fetch was in flight. Their write wins over the fetched copy.
        if (!sameClock(ops.getClock(), before)) {
            return;
        }
        updateUser(fetched.data);
        const clock = clockFrom(fetched.data);
        if (clock.kind === 'running') {
            ops.setClock(checkIn(clock, Date.now()));
        }
    }, [ops, updateUser]);

    // The first sample runs at once, so a running record that arrives from a fetch does not render
    // with the last tick's time.
    useEffect(() => {
        if (!isRunning) {
            return;
        }
        const tick = () => setNow(Date.now());
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [isRunning, since]);

    useEffect(() => {
        const title = document.title.replace(TIMER_TITLE_REGEX, '');
        document.title = isRunning ? `${formatTime(timerSeconds)} - ${title}` : title;
    }, [isRunning, timerSeconds]);

    // Renewals follow the clock's own stretch, so a record that arrives mid-stretch renews on time.
    // Only a failed renewal reaches the interval. A successful one restamps `since`, and the
    // effect re-arms from there.
    useEffect(() => {
        if (!isRunning || since === undefined) {
            return;
        }
        let retry: ReturnType<typeof setInterval> | undefined;
        const id = setTimeout(
            () => {
                void renew();
                retry = setInterval(() => void renew(), CHECK_IN_MS);
            },
            Math.max(0, CHECK_IN_MS - (Date.now() - since)),
        );
        return () => {
            clearTimeout(id);
            clearInterval(retry);
        };
    }, [isRunning, since, renew]);

    // The page that was counting is gone. Stop the clock at its last check-in, once per stretch.
    // The record arrives twice at load, and the second copy can still carry the expired clock.
    const repaired = useRef<number | undefined>(undefined);
    useEffect(() => {
        if (!expired || since === undefined || repaired.current === since) {
            return;
        }
        repaired.current = since;
        ops.setClock(checkIn(ops.getClock(), Date.now()));
    }, [expired, since, ops]);

    const controls = useMemo<TimerControls>(
        () => ({ ...ops, isRunning, isPaused, task, showTask, setShowTask }),
        [ops, isRunning, isPaused, task, showTask],
    );
    // Consumers call this while rendering, so it reads this render rather than the ops' committed one.
    const held = clock.kind === 'idle' ? '' : clock.taskId;
    const getLabel = useCallback(
        (taskId?: string) => {
            if (held && taskId !== held) {
                return t('clearAndRestart');
            }
            if (isRunning) {
                return t('pauseTimer', { time: formatTime(timerSeconds) });
            }
            if (timerSeconds) {
                return t('resumeTimer', { time: formatTime(timerSeconds) });
            }
            return t('startTimer');
        },
        [held, isRunning, timerSeconds, t],
    );
    const timer = useMemo<Timer>(
        () => ({ ...controls, timerSeconds, getLabel }),
        [controls, timerSeconds, getLabel],
    );

    return (
        <TimerControlsContext value={controls}>
            <TimerContext value={timer}>{children}</TimerContext>
        </TimerControlsContext>
    );
}
