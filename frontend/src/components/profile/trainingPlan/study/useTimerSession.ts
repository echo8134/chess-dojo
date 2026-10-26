import { clear, clockFrom, isExpired, pause, start } from '@/components/timer/clock';
import { TimerControlsContext } from '@/components/timer/TimerContext';
import { User } from '@/database/user';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import {
    deduct,
    finish,
    foreignClock,
    harvest,
    HIDDEN_GRACE_MS,
    Session,
    sessionFor,
} from './timerSession';

const isNobody = (session: Session | undefined) =>
    session?.kind === 'attached' && session.pausedBy === 'nobody';

type Timeout = ReturnType<typeof setTimeout>;

/**
 * Tabs on the reader tell each other which one has the session on a task. The latest announce
 * wins, so two tabs restored at once settle on one owner. Equal times fall back to the tab id.
 */
const CHANNEL = 'dojo-reader-timer';
interface HandOff {
    taskId: string;
    tabId: string;
    at: number;
}
const announcedBefore = (other: HandOff, own: HandOff | undefined) =>
    !!own && (other.at < own.at || (other.at === own.at && other.tabId < own.tabId));
const HANDED_OFF: Session = { kind: 'handed-off' };
const newTabId = () => Math.random().toString(36).slice(2);

/**
 * The reader's hold on the work timer for one task. Opening resumes a clock that is idle or
 * paused on the task, claims one running without a task, and adopts a running one. A hidden tab
 * pauses it after a grace period and resumes it, from the server's record, when the tab shows
 * again. Leaving, by unmount or by a full page load, pauses it. A pause the member made is theirs
 * to lift. A stop from Done holds until another game of the task opens. Tabs on the same task tell
 * each other when one opens, and the newest keeps the session until another takes it back. The
 * hook never touches a clock on another task, except to move it here when asked.
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
    /** The task a clock on another task is on, with its whole minutes. Undefined otherwise. */
    foreign: () => { taskId: string; minutes: number } | undefined;
    /**
     * Moves the clock here from the given task, at zero, in one write, and takes the session as
     * a new tab would. Does nothing when the clock is not on that task any more.
     */
    switchHere: (fromTaskId: string) => Promise<void>;
    /**
     * Takes the session back from the tab that took it and opens again, from the server's
     * record, as that tab may have paused or stopped the clock since.
     */
    takeOver: () => Promise<void>;
} {
    const { clock, isRunning, setClock, getClock, reconcile } = use(TimerControlsContext);
    const sessionRef = useRef<Session | undefined>(undefined);
    // Another tab on the task took the session. It owns the clock until this tab takes it back.
    // The hand-off belongs to one visit of one task, so a task change forgets it at once.
    const [visit, setVisit] = useState({ taskId, handedOff: false });
    if (visit.taskId !== taskId) {
        setVisit({ taskId, handedOff: false });
    }
    const handedOff = !!taskId && visit.taskId === taskId && visit.handedOff;
    const session = !taskId
        ? undefined
        : handedOff
          ? HANDED_OFF
          : sessionFor(clock, taskId, isRunning, sessionRef.current);

    // This effect runs after the commit and ahead of the effects below, so on a task change the
    // leave cleanup still reads the old task's session while the open effect reads the new one's.
    useEffect(() => {
        sessionRef.current = session;
    });

    const [tabId] = useState(newTabId);
    const channel = useRef<BroadcastChannel | undefined>(undefined);
    const lastAnnounce = useRef<HandOff | undefined>(undefined);
    // The newest claim heard or made. A later announce goes strictly after it, so a take-over
    // never ties with the claim it answers.
    const newestAt = useRef(0);
    useEffect(() => {
        if (!taskId || typeof BroadcastChannel === 'undefined') {
            return;
        }
        const opened = new BroadcastChannel(CHANNEL);
        opened.onmessage = ({ data }: MessageEvent<Partial<HandOff> | undefined>) => {
            if (data?.taskId !== taskId || data.tabId === tabId || typeof data.at !== 'number') {
                return;
            }
            newestAt.current = Math.max(newestAt.current, data.at);
            if (announcedBefore(data as HandOff, lastAnnounce.current)) {
                return;
            }
            // A pagehide before the next render must not pause the clock for this tab.
            sessionRef.current = HANDED_OFF;
            setVisit({ taskId, handedOff: true });
        };
        channel.current = opened;
        return () => {
            opened.close();
            channel.current = undefined;
        };
    }, [taskId, tabId]);
    const announce = useCallback(
        (taskId: string) => {
            const at = Math.max(Date.now(), newestAt.current + 1);
            const message: HandOff = { taskId, tabId, at };
            lastAnnounce.current = message;
            newestAt.current = at;
            channel.current?.postMessage(message);
        },
        [tabId],
    );

    // The open step also runs again after a take-over, which clears openedFor.
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
        announce(taskId);
        const current = sessionRef.current;
        const taskless = clock.kind !== 'idle' && !clock.taskId;
        if (current?.kind === 'attached' && (current.pausedBy !== 'nobody' || taskless)) {
            void setClock(start(clock, taskId, Date.now()));
        }
    }, [enabled, taskId, clock, setClock, announce, handedOff]);

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
    // The task this tab is on, while it is on it. A reopen or a switch queued behind a mark
    // writes nothing once the reader moved on, left the page or unmounted.
    const alive = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (!taskId) {
            return;
        }
        if (pendingLeave.current?.taskId === taskId) {
            clearTimeout(pendingLeave.current.timer);
            pendingLeave.current = undefined;
        }
        alive.current = taskId;
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
            alive.current = taskId;
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
            alive.current = undefined;
            if (isNobody(sessionRef.current)) {
                void pauseAsReader();
            }
        };
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('pageshow', onVisibility);
        window.addEventListener('pagehide', onPageHide);
        return () => {
            alive.current = undefined;
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
                // A handed-off tab stops the clock without taking the session back.
                if (sessionRef.current?.kind !== 'handed-off') {
                    sessionRef.current = { kind: 'attached', pausedBy: 'done' };
                }
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
        if (!taskId || alive.current !== taskId) {
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

    const foreign = useCallback(
        () => (taskId ? foreignClock(getClock(), taskId, Date.now()) : undefined),
        [taskId, getClock],
    );
    const switchHere = useCallback(
        (fromTaskId: string) => {
            // A switch queued behind a mark can run after the reader left, or after the clock
            // moved elsewhere. The member agreed to move the clock from one task only.
            if (!taskId || alive.current !== taskId) {
                return Promise.resolve();
            }
            const now = Date.now();
            if (foreignClock(getClock(), taskId, now)?.taskId !== fromTaskId) {
                return Promise.resolve();
            }
            sessionRef.current = { kind: 'attached', pausedBy: 'nobody' };
            announce(taskId);
            return setClock(start(clear(), taskId, now));
        },
        [taskId, setClock, getClock, announce],
    );
    const takeOver = useCallback(async () => {
        await reconcile();
        openedFor.current = undefined;
        setVisit((current) => ({ ...current, handedOff: false }));
    }, [reconcile]);

    return { session, peek, commit, reopen, foreign, switchHere, takeOver };
}
