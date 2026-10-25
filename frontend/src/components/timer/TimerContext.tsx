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
     * The clock as this render's user record holds it. Changes only when the record's timer
     * fields do.
     */
    clock: Clock;
    /** Writes the clock as given, in one write. Resolves once the write has reached the server. */
    setClock: (next: Clock) => Promise<void>;
    /** The clock as the latest user record holds it. */
    getClock: () => Clock;
    /**
     * Adopts the server's record and returns its clock. Undefined when the fetch failed or the
     * member acted while it was in flight.
     */
    reconcile: () => Promise<Clock | undefined>;
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

    const { timerSeconds: seconds, timerStartedAt: startedAt, timerTaskId } = user ?? {};
    const clock = useMemo(
        () => clockFrom({ timerSeconds: seconds, timerStartedAt: startedAt, timerTaskId }),
        [seconds, startedAt, timerTaskId],
    );
    const expired = clock.kind === 'running' && isExpired(clock, now);
    const isRunning = clock.kind === 'running' && !expired;
    // An expired clock reads as paused until its repair lands, so the navbar does not flicker.
    const isPaused = (clock.kind === 'paused' && clock.seconds > 0) || expired;
    const timerSeconds = elapsedSeconds(clock, now);
    const since = clock.kind === 'running' ? clock.since : undefined;

    // The ops keep one identity across renders and read the committed render here. A write moves
    // the clock ahead of its commit, and the ref keeps that clock until the commit catches up.
    const latest = useRef({ clock, isRunning, task, api, dirty: false });
    useEffect(() => {
        const { clock: written, dirty } = latest.current;
        latest.current = { clock: dirty ? written : clock, isRunning, task, api, dirty: false };
    });

    // Writes go out one at a time, so the server applies them in the order they were made.
    const chain = useRef<Promise<void>>(Promise.resolve());
    const generation = useRef(0);
    const lastWritten = useRef<Clock | undefined>(undefined);
    const ops = useMemo(() => {
        const getClock = () => latest.current.clock;
        const write = (next: Clock) => {
            const fields = toUserFields(next);
            latest.current.clock = next;
            latest.current.dirty = true;
            lastWritten.current = next;
            setNow(Date.now());
            updateUser(fields);
            const gen = ++generation.current;
            // The response applies the server's record, which can be older than a write made since.
            // onDone puts that newer write back from its own copy, which no render touches.
            const onDone = () => {
                if (gen !== generation.current && lastWritten.current) {
                    updateUser(toUserFields(lastWritten.current));
                }
            };
            // The reader pauses the clock while the page unloads, so the write must outlive the page.
            chain.current = chain.current
                .then(() => latest.current.api.updateUser(fields, undefined, { keepalive: true }))
                .then(onDone, () => undefined);
            return chain.current;
        };
        const onOtherTask = (taskId?: string) => {
            const clock = getClock();
            return clock.kind !== 'idle' && !!clock.taskId && taskId !== clock.taskId;
        };
        const onStart = (taskId?: string) => void write(start(getClock(), taskId, Date.now()));
        const onPause = (taskId?: string, openDialog?: boolean) => {
            void write(pause(getClock(), Date.now(), taskId));
            if (openDialog && latest.current.task) {
                setShowTask(true);
            }
        };
        const reconcile = async () => {
            const before = getClock();
            // A copy read while this tab's own writes are in flight would be older than they are.
            await chain.current;
            const fetched = await latest.current.api.getUser().catch(() => undefined);
            if (!fetched) {
                return undefined;
            }
            // The member acted while the fetch was in flight. Their write wins over the fetched copy.
            if (!sameClock(getClock(), before)) {
                return undefined;
            }
            updateUser(fetched.data);
            return clockFrom(fetched.data);
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
            onClear: () => void write(clear()),
            setClock: write,
            getClock,
            reconcile,
        };
    }, [updateUser]);

    // Banks the stretch so far, after adopting the server's copy. Otherwise this tab would write
    // "running" over a pause, clear or task switch made in another tab.
    const renew = useCallback(async () => {
        const clock = await ops.reconcile();
        if (clock?.kind === 'running') {
            void ops.setClock(checkIn(clock, Date.now()));
        }
    }, [ops]);

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
        // A child's effect in this commit may have started the clock already.
        const current = ops.getClock();
        if (current.kind !== 'running' || !isExpired(current, Date.now())) {
            return;
        }
        void ops.setClock(checkIn(current, Date.now()));
    }, [expired, since, ops]);

    const controls = useMemo<TimerControls>(
        () => ({ ...ops, clock, isRunning, isPaused, task, showTask, setShowTask }),
        [ops, clock, isRunning, isPaused, task, showTask],
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
