import { clockFrom, isExpired, pause, start } from '@/components/timer/clock';
import { TimerControlsContext } from '@/components/timer/TimerContext';
import { User } from '@/database/user';
import { use, useCallback, useEffect, useRef } from 'react';
import { deduct, finish, harvest, HIDDEN_GRACE_MS, Session, sessionFor } from './timerSession';

const isNobody = (session: Session | undefined) =>
    session?.kind === 'attached' && session.pausedBy === 'nobody';

type Timeout = ReturnType<typeof setTimeout>;

/**
 * The reader's hold on the work timer for one task. Opening resumes a clock that is idle or
 * paused on the task, claims one running without a task, and adopts a running one. A hidden tab
 * pauses it after a grace period and resumes it, from the server's record, when the tab shows
 * again. Leaving, by unmount or by a full page load, pauses it. A pause the member made is theirs
 * to lift. A stop from Done holds until another game of the task opens. The hook never touches a
 * clock on another task.
 */
export function useTimerSession(
    taskId: string | undefined,
    enabled: boolean,
): {
    /** Undefined while there is no task. */
    session: Session | undefined;
    /** Whole minutes a mark posts, from the record the mark fetched, or from the clock as held. */
    peek: (fresh?: User) => number;
    /**
     * Takes the posted minutes off the clock as it is now. With `stop` the clock pauses with the
     * remainder and the session reads done until `reopen`. Without it the clock keeps its run
     * state. Resolves once the write has reached the server, or at once when there is nothing to
     * write.
     */
    commit: (minutes: number, opts: { stop: boolean }) => Promise<void>;
    /** Starts a clock that Done stopped, from its remainder. Leaves any other clock alone. */
    reopen: () => Promise<void>;
} {
    const { clock, isRunning, setClock, getClock, reconcile } = use(TimerControlsContext);
    const sessionRef = useRef<Session | undefined>(undefined);
    const session = taskId ? sessionFor(clock, taskId, isRunning, sessionRef.current) : undefined;

    // This effect runs after the commit and ahead of the effects below, so on a task change the
    // leave cleanup still reads the old task's session while the open effect reads the new one's.
    useEffect(() => {
        sessionRef.current = session;
    });

    const openedFor = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (!taskId) {
            openedFor.current = undefined;
            return;
        }
        if (!enabled || openedFor.current === taskId) {
            return;
        }
        openedFor.current = taskId;
        const current = sessionRef.current;
        const taskless = clock.kind !== 'idle' && !clock.taskId;
        if (current?.kind === 'attached' && (current.pausedBy !== 'nobody' || taskless)) {
            void setClock(start(clock, taskId, Date.now()));
        }
    }, [enabled, taskId, clock, setClock]);

    const grace = useRef<Timeout | undefined>(undefined);
    const cancelGrace = useCallback(() => {
        clearTimeout(grace.current);
        grace.current = undefined;
    }, []);
    const pauseAsReader = useCallback(() => {
        sessionRef.current = { kind: 'attached', pausedBy: 'reader' };
        return setClock(pause(getClock(), Date.now()));
    }, [setClock, getClock]);
    const armGrace = useCallback(() => {
        if (grace.current !== undefined) {
            return;
        }
        grace.current = setTimeout(() => {
            grace.current = undefined;
            if (document.visibilityState === 'hidden' && isNobody(sessionRef.current)) {
                void pauseAsReader();
            }
        }, HIDDEN_GRACE_MS);
    }, [pauseAsReader]);

    // A reader opened in a background tab, or hidden while the book loads, gets no visibility event.
    const nobody = isNobody(session);
    useEffect(() => {
        if (!taskId) {
            return;
        }
        if (!nobody) {
            cancelGrace();
        } else if (document.visibilityState === 'hidden') {
            armGrace();
        }
    }, [nobody, taskId, armGrace, cancelGrace]);

    const pendingLeave = useRef<{ taskId: string; timer: Timeout } | undefined>(undefined);
    const alive = useRef(false);
    useEffect(() => {
        if (!taskId) {
            return;
        }
        if (pendingLeave.current?.taskId === taskId) {
            clearTimeout(pendingLeave.current.timer);
            pendingLeave.current = undefined;
        }
        alive.current = true;
        let cancelled = false;
        // The record may have moved while the tab was hidden, so the resume starts from the
        // server's copy, and only when that copy still reads as paused by the reader.
        const resume = async () => {
            const fresh = await reconcile();
            if (!fresh || cancelled) {
                return;
            }
            const running = fresh.kind === 'running' && !isExpired(fresh, Date.now());
            const next = sessionFor(fresh, taskId, running, sessionRef.current);
            // Only the reader's own pause lifts here. A Done made during the fetch holds.
            if (next.kind === 'attached' && next.pausedBy === 'reader') {
                void setClock(start(fresh, taskId, Date.now()));
            }
        };
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') {
                cancelled = true;
                if (isNobody(sessionRef.current)) {
                    armGrace();
                }
                return;
            }
            cancelGrace();
            if (
                sessionRef.current?.kind === 'attached' &&
                sessionRef.current.pausedBy === 'reader'
            ) {
                cancelled = false;
                void resume();
            }
        };
        // A full page load never unmounts the reader. A restore from the back-forward cache
        // shows the page again, and the visible path resumes.
        const onPageHide = () => {
            cancelGrace();
            if (isNobody(sessionRef.current)) {
                void pauseAsReader();
            }
        };
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('pageshow', onVisibility);
        window.addEventListener('pagehide', onPageHide);
        return () => {
            alive.current = false;
            cancelled = true;
            cancelGrace();
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('pageshow', onVisibility);
            window.removeEventListener('pagehide', onPageHide);
            if (!isNobody(sessionRef.current)) {
                return;
            }
            // Strict Mode replays the cleanup and the setup at once in development. The write
            // waits a tick so a setup for the same task can take it back.
            pendingLeave.current = {
                taskId,
                timer: setTimeout(() => void setClock(pause(getClock(), Date.now())), 0),
            };
        };
    }, [taskId, setClock, getClock, reconcile, armGrace, cancelGrace, pauseAsReader]);

    const peek = useCallback(
        (fresh?: User) =>
            taskId
                ? (harvest(fresh ? clockFrom(fresh) : getClock(), taskId, Date.now())?.minutes ?? 0)
                : 0,
        [taskId, getClock],
    );
    const commit = useCallback(
        (minutes: number, { stop }: { stop: boolean }) => {
            if (!taskId) {
                return Promise.resolve();
            }
            if (stop) {
                const next = finish(getClock(), taskId, minutes, Date.now());
                if (!next) {
                    return Promise.resolve();
                }
                sessionRef.current = { kind: 'attached', pausedBy: 'done' };
                return setClock(next);
            }
            if (minutes === 0) {
                return Promise.resolve();
            }
            const next = deduct(getClock(), taskId, minutes, Date.now());
            return next ? setClock(next) : Promise.resolve();
        },
        [taskId, setClock, getClock],
    );
    const reopen = useCallback(() => {
        // A reopen queued behind a mark can run after the reader left. The leave paused the clock.
        if (!taskId || !alive.current) {
            return Promise.resolve();
        }
        const now = Date.now();
        const clock = getClock();
        const running = clock.kind === 'running' && !isExpired(clock, now);
        const current = sessionFor(clock, taskId, running, sessionRef.current);
        if (current.kind !== 'attached' || current.pausedBy !== 'done') {
            return Promise.resolve();
        }
        // A pagehide before the next render must see the clock as running.
        sessionRef.current = { kind: 'attached', pausedBy: 'nobody' };
        return setClock(start(clock, taskId, now));
    }, [taskId, setClock, getClock]);

    return { session, peek, commit, reopen };
}
