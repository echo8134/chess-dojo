import { Clock, isExpired } from '@/components/timer/clock';
import { TimerControls, TimerControlsContext } from '@/components/timer/TimerContext';
import { User } from '@/database/user';
import { act, cleanup, renderHook } from '@testing-library/react';
import { ReactNode, StrictMode, useMemo, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTimerSession } from './useTimerSession';

const NOW = Date.parse('2026-10-24T18:00:00.000Z');
const secondsAgo = (s: number) => NOW - s * 1000;
const running = (taskId: string, base: number, since: number): Clock => ({
    kind: 'running',
    taskId,
    base,
    since,
});
const paused = (taskId: string, seconds: number): Clock => ({ kind: 'paused', taskId, seconds });
const idle: Clock = { kind: 'idle' };

let visibility: DocumentVisibilityState = 'visible';
/** Changes the tab's visibility and lets a resume's fetch settle. */
const show = (state: DocumentVisibilityState) =>
    act(() => {
        visibility = state;
        document.dispatchEvent(new Event('visibilitychange'));
        return Promise.resolve();
    });
const pageShow = () =>
    act(() => {
        window.dispatchEvent(new Event('pageshow'));
        return Promise.resolve();
    });
const pageHide = () =>
    act(() => {
        window.dispatchEvent(new Event('pagehide'));
    });
const advance = (ms: number) =>
    act(() => {
        vi.advanceTimersByTime(ms);
    });

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

interface Props {
    taskId: string | undefined;
    enabled: boolean;
}
const ON_TASK_A: Props = { taskId: 'task-a', enabled: true };

/**
 * A provider over one mutable clock, the way the real one sits over the user record. A write
 * through the controls, or a change the test makes as the member, re-renders the consumers. A
 * reconcile answers with the clock as held, as a server that saw every write would, unless the
 * test puts another record on the server.
 */
function mount(initial: Clock, props: Props = ON_TASK_A, { strict = false } = {}) {
    let clock = initial;
    const listeners = new Set<() => void>();
    const change = (next: Clock) => {
        clock = next;
        listeners.forEach((notify) => notify());
    };
    const setClock = vi.fn((next: Clock) => {
        change(next);
        return Promise.resolve();
    });
    const getClock = () => clock;
    const reconcile = vi.fn(() => Promise.resolve<Clock | undefined>(clock));
    function Provider({ children }: { children: ReactNode }) {
        const current = useSyncExternalStore(
            (notify) => {
                listeners.add(notify);
                return () => listeners.delete(notify);
            },
            () => clock,
        );
        const value = useMemo(
            () =>
                ({
                    clock: current,
                    isRunning: current.kind === 'running' && !isExpired(current, Date.now()),
                    setClock,
                    getClock,
                    reconcile,
                }) as unknown as TimerControls,
            [current],
        );
        return (
            <TimerControlsContext.Provider value={value}>{children}</TimerControlsContext.Provider>
        );
    }
    const wrapper = strict
        ? ({ children }: { children: ReactNode }) => (
              <StrictMode>
                  <Provider>{children}</Provider>
              </StrictMode>
          )
        : Provider;
    const rendered = renderHook((p: Props) => useTimerSession(p.taskId, p.enabled), {
        wrapper,
        initialProps: props,
    });
    return {
        ...rendered,
        setClock,
        reconcile,
        clock: getClock,
        /** The member acts through another control, so the clock changes without the hook's doing. */
        member: (next: Clock) => act(() => change(next)),
        /** The server holds another record than this tab, as after a write from another device. */
        server: (next: Clock) =>
            reconcile.mockImplementationOnce(() => {
                change(next);
                return Promise.resolve(next);
            }),
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibility,
    });
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('useTimerSession at open', () => {
    it('starts a clock paused on the task from its seconds', () => {
        const { result, setClock } = mount(paused('task-a', 100));
        expect(setClock.mock.calls).toEqual([[running('task-a', 100, NOW)]]);
        expect(result.current.session).toEqual({ kind: 'attached', pausedBy: 'nobody' });
    });

    it('starts an idle clock on the task', () => {
        const { setClock } = mount(idle);
        expect(setClock.mock.calls).toEqual([[running('task-a', 0, NOW)]]);
    });

    it('resumes an expired running clock on the task from its banked seconds', () => {
        const { setClock } = mount(running('task-a', 600, secondsAgo(11 * 60)));
        expect(setClock.mock.calls).toEqual([[running('task-a', 600, NOW)]]);
    });

    it('adopts a running clock on the task without a write', () => {
        const { result, setClock } = mount(running('task-a', 10, secondsAgo(30)));
        expect(setClock).not.toHaveBeenCalled();
        expect(result.current.session).toEqual({ kind: 'attached', pausedBy: 'nobody' });
    });

    it('claims a clock running without a task, keeping its seconds', () => {
        const { result, setClock } = mount(running('', 10, secondsAgo(30)));
        expect(setClock.mock.calls).toEqual([[running('task-a', 40, NOW)]]);
        expect(result.current.session).toEqual({ kind: 'attached', pausedBy: 'nobody' });
    });

    it('claims a clock paused without a task, keeping its seconds', () => {
        const { setClock } = mount(paused('', 100));
        expect(setClock.mock.calls).toEqual([[running('task-a', 100, NOW)]]);
    });

    it("leaves another task's clock alone", () => {
        const { result, setClock, unmount } = mount(paused('task-b', 100));
        expect(result.current.session).toEqual({ kind: 'foreign' });
        unmount();
        advance(0);
        expect(setClock).not.toHaveBeenCalled();
    });

    it('waits until it is enabled, then opens once', () => {
        const { setClock, rerender } = mount(paused('task-a', 100), {
            ...ON_TASK_A,
            enabled: false,
        });
        expect(setClock).not.toHaveBeenCalled();
        rerender({ taskId: 'task-a', enabled: true });
        rerender({ taskId: 'task-a', enabled: true });
        expect(setClock.mock.calls).toEqual([[running('task-a', 100, NOW)]]);
    });

    it('opens again when the task comes back after it went away', () => {
        const { setClock, rerender } = mount(running('task-a', 10, secondsAgo(30)));
        rerender({ taskId: undefined, enabled: true });
        advance(0);
        expect(setClock.mock.calls).toEqual([[paused('task-a', 40)]]);
        rerender({ taskId: 'task-a', enabled: true });
        expect(setClock.mock.calls).toEqual([[paused('task-a', 40)], [running('task-a', 40, NOW)]]);
    });

    it('has no session without a task', () => {
        const { result, setClock } = mount(paused('task-a', 100), {
            taskId: undefined,
            enabled: true,
        });
        expect(result.current.session).toBeUndefined();
        expect(result.current.peek()).toBe(0);
        expect(setClock).not.toHaveBeenCalled();
    });
});

describe('useTimerSession under Strict Mode replays', () => {
    it('does not pause a running clock when the effects are replayed', () => {
        const { setClock } = mount(running('task-a', 10, secondsAgo(30)), ON_TASK_A, {
            strict: true,
        });
        advance(0);
        expect(setClock).not.toHaveBeenCalled();
    });

    it('opens a paused clock once when the effects are replayed', () => {
        const { setClock } = mount(paused('task-a', 100), ON_TASK_A, { strict: true });
        advance(0);
        expect(setClock.mock.calls).toEqual([[running('task-a', 100, NOW)]]);
    });
});

describe('useTimerSession while hidden and visible', () => {
    it('pauses after a minute hidden and resumes when shown again', async () => {
        const { result, setClock, reconcile } = mount(running('task-a', 10, secondsAgo(30)));
        await show('hidden');
        advance(59_000);
        expect(setClock).not.toHaveBeenCalled();
        advance(1_000);
        expect(setClock.mock.calls).toEqual([[paused('task-a', 100)]]);
        expect(result.current.session).toEqual({ kind: 'attached', pausedBy: 'reader' });

        await show('visible');
        expect(reconcile).toHaveBeenCalledTimes(1);
        expect(setClock.mock.calls).toEqual([
            [paused('task-a', 100)],
            [running('task-a', 100, NOW + 60_000)],
        ]);
        expect(result.current.session).toEqual({ kind: 'attached', pausedBy: 'nobody' });
    });

    it('pauses a clock it started while hidden, with no visibility event', () => {
        visibility = 'hidden';
        const { setClock } = mount(paused('task-a', 100));
        expect(setClock.mock.calls).toEqual([[running('task-a', 100, NOW)]]);
        advance(60_000);
        expect(setClock.mock.calls).toEqual([
            [running('task-a', 100, NOW)],
            [paused('task-a', 160)],
        ]);
    });

    it('writes nothing when shown again within the grace period', async () => {
        const { setClock, reconcile } = mount(running('task-a', 10, secondsAgo(30)));
        await show('hidden');
        advance(30_000);
        await show('visible');
        advance(60_000);
        expect(setClock).not.toHaveBeenCalled();
        expect(reconcile).not.toHaveBeenCalled();
    });

    it("does not lift the member's pause when shown again", async () => {
        const { result, setClock, member } = mount(running('task-a', 10, secondsAgo(30)));
        member(paused('task-a', 40));
        expect(result.current.session).toEqual({ kind: 'attached', pausedBy: 'member' });
        await show('hidden');
        advance(60_000);
        await show('visible');
        expect(setClock).not.toHaveBeenCalled();
    });

    it('drops the grace pause when the member pauses while hidden', async () => {
        const { setClock, member } = mount(running('task-a', 10, secondsAgo(30)));
        await show('hidden');
        advance(30_000);
        member(paused('task-a', 70));
        advance(30_000);
        await show('visible');
        expect(setClock).not.toHaveBeenCalled();
    });

    it('resumes after the member starts the clock the reader had paused', async () => {
        const { result, setClock, member } = mount(running('task-a', 10, secondsAgo(30)));
        await show('hidden');
        advance(60_000);
        member(running('task-a', 100, NOW + 60_000));
        expect(result.current.session).toEqual({ kind: 'attached', pausedBy: 'nobody' });
        await show('visible');
        expect(setClock.mock.calls).toEqual([[paused('task-a', 100)]]);
    });

    it('resumes on pageshow, as after a restore from the back-forward cache', async () => {
        const { setClock } = mount(running('task-a', 10, secondsAgo(30)));
        pageHide();
        expect(setClock.mock.calls).toEqual([[paused('task-a', 40)]]);
        await pageShow();
        expect(setClock.mock.calls).toEqual([[paused('task-a', 40)], [running('task-a', 40, NOW)]]);
    });
});

describe('useTimerSession reads the record before it resumes', () => {
    async function pausedByReader() {
        const mounted = mount(running('task-a', 10, secondsAgo(30)));
        await show('hidden');
        advance(60_000);
        expect(mounted.setClock.mock.calls).toEqual([[paused('task-a', 100)]]);
        return mounted;
    }

    it('leaves a clock that moved to another task alone and reads foreign', async () => {
        const { result, setClock, server } = await pausedByReader();
        server(paused('task-b', 30));
        await show('visible');
        expect(setClock.mock.calls).toEqual([[paused('task-a', 100)]]);
        expect(result.current.session).toEqual({ kind: 'foreign' });
    });

    it('starts from the seconds the record holds, not the ones this tab knew', async () => {
        const { setClock, server } = await pausedByReader();
        server(paused('task-a', 250));
        await show('visible');
        expect(setClock.mock.calls).toEqual([
            [paused('task-a', 100)],
            [running('task-a', 250, NOW + 60_000)],
        ]);
    });

    it('adopts a clock the record says is running without a write', async () => {
        const { result, setClock, server } = await pausedByReader();
        server(running('task-a', 100, NOW + 30_000));
        await show('visible');
        expect(setClock.mock.calls).toEqual([[paused('task-a', 100)]]);
        expect(result.current.session).toEqual({ kind: 'attached', pausedBy: 'nobody' });
    });

    it('writes nothing when the record cannot be read', async () => {
        const { result, setClock, reconcile } = await pausedByReader();
        reconcile.mockResolvedValueOnce(undefined);
        await show('visible');
        expect(setClock.mock.calls).toEqual([[paused('task-a', 100)]]);
        expect(result.current.session).toEqual({ kind: 'attached', pausedBy: 'reader' });
    });

    it('drops the resume when the tab hides again during the fetch', async () => {
        const { setClock, reconcile } = await pausedByReader();
        const fetch = deferred<Clock | undefined>();
        reconcile.mockImplementationOnce(() => fetch.promise);
        await show('visible');
        expect(reconcile).toHaveBeenCalledTimes(1);
        await show('hidden');
        await act(() => {
            fetch.resolve(paused('task-a', 100));
            return Promise.resolve();
        });
        expect(setClock.mock.calls).toEqual([[paused('task-a', 100)]]);
    });
});

describe('useTimerSession on leave', () => {
    it('pauses a running clock on unmount', () => {
        const { setClock, unmount } = mount(running('task-a', 10, secondsAgo(30)));
        unmount();
        expect(setClock).not.toHaveBeenCalled();
        advance(0);
        expect(setClock.mock.calls).toEqual([[paused('task-a', 40)]]);
    });

    it('writes nothing on unmount when the member paused the clock', () => {
        const { setClock, member, unmount } = mount(running('task-a', 10, secondsAgo(30)));
        member(paused('task-a', 40));
        unmount();
        advance(0);
        expect(setClock).not.toHaveBeenCalled();
    });

    it("pauses the old task's clock when the task changes and leaves it foreign for the new one", () => {
        const { result, setClock, rerender } = mount(running('task-a', 10, secondsAgo(30)));
        rerender({ taskId: 'task-b', enabled: true });
        advance(0);
        expect(setClock.mock.calls).toEqual([[paused('task-a', 40)]]);
        expect(result.current.session).toEqual({ kind: 'foreign' });
    });

    it('pauses a running clock when the page hides, as the reader', () => {
        const { result, setClock } = mount(running('task-a', 10, secondsAgo(30)));
        pageHide();
        expect(setClock.mock.calls).toEqual([[paused('task-a', 40)]]);
        expect(result.current.session).toEqual({ kind: 'attached', pausedBy: 'reader' });
    });

    it('writes nothing when the page hides on a paused clock', () => {
        const { setClock, member } = mount(running('task-a', 10, secondsAgo(30)));
        member(paused('task-a', 40));
        pageHide();
        expect(setClock).not.toHaveBeenCalled();
    });
});

describe('useTimerSession peek and commit', () => {
    it('peeks the minutes from the record given, not from the clock as held', () => {
        const { result } = mount(running('task-a', 479, NOW));
        const fetched = { timerTaskId: 'task-a', timerSeconds: 125, timerStartedAt: '' } as User;
        expect(result.current.peek(fetched)).toBe(2);
        expect(result.current.peek()).toBe(7);
        const elsewhere = { timerTaskId: 'task-b', timerSeconds: 125, timerStartedAt: '' } as User;
        expect(result.current.peek(elsewhere)).toBe(0);
    });

    it('commits by taking the posted minutes off the clock as it is at the time', async () => {
        const { result, setClock } = mount(running('task-a', 479, NOW));
        advance(65_000);
        await act(() => result.current.commit(7, { stop: false }));
        expect(setClock.mock.calls).toEqual([[running('task-a', 124, NOW + 65_000)]]);
    });

    it('commits a pause the member made during the post as paused', async () => {
        const { result, setClock, member } = mount(running('task-a', 479, NOW));
        member(paused('task-a', 500));
        await act(() => result.current.commit(7, { stop: false }));
        expect(setClock.mock.calls).toEqual([[paused('task-a', 80)]]);
    });

    it('commits nothing when the clock moved to another task', async () => {
        const { result, setClock, member } = mount(running('task-a', 479, NOW));
        member(running('task-b', 0, NOW));
        await act(() => result.current.commit(7, { stop: false }));
        expect(setClock).not.toHaveBeenCalled();
    });

    it('commits nothing for zero minutes', async () => {
        const { result, setClock, member } = mount(running('task-a', 30, NOW));
        member(paused('task-a', 30));
        await expect(result.current.commit(0, { stop: false })).resolves.toBeUndefined();
        expect(setClock).not.toHaveBeenCalled();
    });

    it('resolves once the write has landed', async () => {
        const { result, setClock } = mount(running('task-a', 479, NOW));
        const written = deferred<undefined>();
        setClock.mockImplementationOnce(() => written.promise);
        let settled = false;
        act(() => {
            void result.current.commit(7, { stop: false }).then(() => {
                settled = true;
            });
        });
        await act(() => Promise.resolve());
        expect(settled).toBe(false);
        await act(() => {
            written.resolve(undefined);
            return Promise.resolve();
        });
        expect(settled).toBe(true);
    });
});

describe('useTimerSession when Done stops the clock', () => {
    const done = { kind: 'attached', pausedBy: 'done' };
    async function stoppedByDone() {
        const mounted = mount(running('task-a', 479, NOW));
        await act(() => mounted.result.current.commit(7, { stop: true }));
        expect(mounted.setClock.mock.calls).toEqual([[paused('task-a', 59)]]);
        expect(mounted.result.current.session).toEqual(done);
        return mounted;
    }

    it('stops a running clock with the remainder and reads done', async () => {
        await stoppedByDone();
    });

    it('stops a clock the member paused, taking the posted minutes off it', async () => {
        const { result, setClock, member } = mount(running('task-a', 479, NOW));
        member(paused('task-a', 125));
        await act(() => result.current.commit(2, { stop: true }));
        expect(setClock.mock.calls).toEqual([[paused('task-a', 5)]]);
        expect(result.current.session).toEqual(done);
    });

    it('stops the clock for zero minutes', async () => {
        const { result, setClock } = mount(running('task-a', 30, NOW));
        await act(() => result.current.commit(0, { stop: true }));
        expect(setClock.mock.calls).toEqual([[paused('task-a', 30)]]);
        expect(result.current.session).toEqual(done);
    });

    it('writes nothing and stays foreign when the clock moved to another task', async () => {
        const { result, setClock, member } = mount(running('task-a', 479, NOW));
        member(running('task-b', 0, NOW));
        await act(() => result.current.commit(7, { stop: true }));
        expect(setClock).not.toHaveBeenCalled();
        expect(result.current.session).toEqual({ kind: 'foreign' });
    });

    it('starts again from the remainder when another game of the task opens', async () => {
        const { result, setClock } = await stoppedByDone();
        advance(10_000);
        await act(() => result.current.reopen());
        expect(setClock.mock.calls).toEqual([
            [paused('task-a', 59)],
            [running('task-a', 59, NOW + 10_000)],
        ]);
        expect(result.current.session).toEqual({ kind: 'attached', pausedBy: 'nobody' });
    });

    it('leaves a pause the member made alone when another game opens', async () => {
        const { result, setClock, member } = mount(running('task-a', 10, secondsAgo(30)));
        member(paused('task-a', 40));
        await act(() => result.current.reopen());
        expect(setClock).not.toHaveBeenCalled();
        expect(result.current.session).toEqual({ kind: 'attached', pausedBy: 'member' });
    });

    it('leaves a running clock alone when another game opens', async () => {
        const { result, setClock } = mount(running('task-a', 10, secondsAgo(30)));
        await act(() => result.current.reopen());
        expect(setClock).not.toHaveBeenCalled();
        expect(result.current.session).toEqual({ kind: 'attached', pausedBy: 'nobody' });
    });

    it('drops the stop when the member clears the clock, so another game leaves it idle', async () => {
        const { result, setClock, member, clock } = await stoppedByDone();
        member(idle);
        expect(result.current.session).toEqual({ kind: 'attached', pausedBy: 'member' });
        await act(() => result.current.reopen());
        expect(setClock.mock.calls).toEqual([[paused('task-a', 59)]]);
        expect(clock()).toEqual(idle);
    });

    it('writes nothing for a reopen that runs once the reader is gone', async () => {
        const { result, setClock, unmount } = await stoppedByDone();
        unmount();
        await act(() => result.current.reopen());
        expect(setClock.mock.calls).toEqual([[paused('task-a', 59)]]);
    });

    it('pauses on pagehide right after a reopen, before the next render', async () => {
        const { result, setClock } = await stoppedByDone();
        await act(() => {
            const started = result.current.reopen();
            window.dispatchEvent(new Event('pagehide'));
            return started;
        });
        expect(setClock.mock.calls).toEqual([
            [paused('task-a', 59)],
            [running('task-a', 59, NOW)],
            [paused('task-a', 59)],
        ]);
    });

    it('holds a Done made while the visible resume is still reading the record', async () => {
        const { result, setClock, reconcile } = mount(running('task-a', 30, NOW));
        await show('hidden');
        advance(60_000);
        expect(setClock.mock.calls).toEqual([[paused('task-a', 90)]]);
        const fetch = deferred<Clock | undefined>();
        reconcile.mockImplementationOnce(() => fetch.promise);
        await show('visible');
        await act(() => result.current.commit(0, { stop: true }));
        await act(() => {
            fetch.resolve(paused('task-a', 90));
            return Promise.resolve();
        });
        expect(setClock.mock.calls).toEqual([[paused('task-a', 90)], [paused('task-a', 90)]]);
        expect(result.current.session).toEqual(done);
    });

    it('holds through a hidden tab and writes nothing when shown again', async () => {
        const { result, setClock, reconcile } = await stoppedByDone();
        await show('hidden');
        advance(120_000);
        await show('visible');
        expect(setClock.mock.calls).toEqual([[paused('task-a', 59)]]);
        expect(reconcile).not.toHaveBeenCalled();
        expect(result.current.session).toEqual(done);
    });

    it('holds when the page hides', async () => {
        const { result, setClock } = await stoppedByDone();
        pageHide();
        expect(setClock.mock.calls).toEqual([[paused('task-a', 59)]]);
        expect(result.current.session).toEqual(done);
    });

    it('holds through unmount without a write', async () => {
        const { setClock, unmount } = await stoppedByDone();
        unmount();
        advance(0);
        expect(setClock.mock.calls).toEqual([[paused('task-a', 59)]]);
    });
});
