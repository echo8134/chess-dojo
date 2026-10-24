import { describe, expect, it } from 'vitest';
import {
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

const NOW = Date.parse('2026-05-27T12:00:00.000Z');
const secondsAgo = (s: number) => NOW - s * 1000;
const running = (taskId: string, base: number, since: number): Clock => ({
    kind: 'running',
    taskId,
    base,
    since,
});
const paused = (taskId: string, seconds: number): Clock => ({ kind: 'paused', taskId, seconds });

describe('clockFrom', () => {
    it('reads no user and an empty record as idle', () => {
        expect(clockFrom(undefined)).toEqual({ kind: 'idle' });
        expect(clockFrom({})).toEqual({ kind: 'idle' });
        expect(clockFrom({ timerSeconds: 0, timerStartedAt: '', timerTaskId: '' })).toEqual({
            kind: 'idle',
        });
    });

    it('reads a start time as running from the banked seconds', () => {
        expect(
            clockFrom({
                timerSeconds: 60,
                timerStartedAt: '2026-05-27T11:59:30.000Z',
                timerTaskId: 'task-a',
            }),
        ).toEqual(running('task-a', 60, secondsAgo(30)));
        expect(clockFrom({ timerStartedAt: '2026-05-27T12:00:00.000Z' })).toEqual(
            running('', 0, NOW),
        );
    });

    it('reads banked seconds without a start time as paused', () => {
        expect(clockFrom({ timerSeconds: 45, timerTaskId: 'task-a' })).toEqual(
            paused('task-a', 45),
        );
        expect(clockFrom({ timerSeconds: 45 })).toEqual(paused('', 45));
    });

    it('keeps a task with no seconds as paused at zero', () => {
        expect(clockFrom({ timerTaskId: 'task-a' })).toEqual(paused('task-a', 0));
    });

    it('reads a start time that does not parse as paused at the seconds', () => {
        expect(
            clockFrom({ timerSeconds: 90, timerStartedAt: 'garbage', timerTaskId: 'task-a' }),
        ).toEqual(paused('task-a', 90));
    });
});

describe('toUserFields', () => {
    it('writes idle as the three empty fields', () => {
        expect(toUserFields({ kind: 'idle' })).toEqual({
            timerSeconds: 0,
            timerStartedAt: '',
            timerTaskId: '',
        });
    });

    it('writes paused as the seconds and the task, with no start time', () => {
        expect(toUserFields(paused('task-a', 125))).toEqual({
            timerSeconds: 125,
            timerStartedAt: '',
            timerTaskId: 'task-a',
        });
    });

    it('writes running as the base, the start time and the task', () => {
        expect(toUserFields(running('task-a', 60, secondsAgo(30)))).toEqual({
            timerSeconds: 60,
            timerStartedAt: '2026-05-27T11:59:30.000Z',
            timerTaskId: 'task-a',
        });
    });

    it('round-trips through clockFrom for all three kinds', () => {
        const clocks: Clock[] = [
            { kind: 'idle' },
            paused('task-a', 125),
            running('task-a', 60, secondsAgo(30)),
        ];
        for (const clock of clocks) {
            expect(clockFrom(toUserFields(clock))).toEqual(clock);
        }
    });
});

describe('isExpired', () => {
    it('is true only for a running clock whose start is older than ten minutes', () => {
        expect(isExpired(running('task-a', 0, secondsAgo(11 * 60)), NOW)).toBe(true);
        expect(isExpired(running('task-a', 0, secondsAgo(10 * 60)), NOW)).toBe(false);
        expect(isExpired(running('task-a', 0, secondsAgo(30)), NOW)).toBe(false);
        expect(isExpired(paused('task-a', 600), NOW)).toBe(false);
        expect(isExpired({ kind: 'idle' }, NOW)).toBe(false);
    });
});

describe('elapsedSeconds', () => {
    it('is zero when idle', () => {
        expect(elapsedSeconds({ kind: 'idle' }, NOW)).toBe(0);
    });

    it('is the banked seconds when paused', () => {
        expect(elapsedSeconds(paused('task-a', 125), NOW)).toBe(125);
    });

    it('adds the whole seconds since the start while running', () => {
        expect(elapsedSeconds(running('task-a', 60, secondsAgo(30)), NOW)).toBe(90);
        expect(elapsedSeconds(running('task-a', 60, secondsAgo(30.9)), NOW)).toBe(90);
    });

    it('stops at the base once the clock has expired', () => {
        expect(elapsedSeconds(running('task-a', 600, secondsAgo(11 * 60)), NOW)).toBe(600);
    });

    it('does not count a start that is still ahead', () => {
        expect(elapsedSeconds(running('task-a', 60, NOW + 5000), NOW)).toBe(60);
    });
});

describe('sameClock', () => {
    it('is true for clocks that write the same fields', () => {
        expect(sameClock(running('task-a', 60, NOW), running('task-a', 60, NOW))).toBe(true);
        expect(sameClock(paused('task-a', 60), paused('task-a', 60))).toBe(true);
        expect(sameClock({ kind: 'idle' }, { kind: 'idle' })).toBe(true);
    });

    it('is false when the seconds, the start or the task differ', () => {
        const base = running('task-a', 60, NOW);
        expect(sameClock(base, running('task-a', 61, NOW))).toBe(false);
        expect(sameClock(base, running('task-a', 60, NOW + 1000))).toBe(false);
        expect(sameClock(base, running('task-b', 60, NOW))).toBe(false);
        expect(sameClock(base, paused('task-a', 60))).toBe(false);
    });
});

describe('start', () => {
    it('starts an idle clock on the task from zero', () => {
        expect(start({ kind: 'idle' }, 'task-a', NOW)).toEqual(running('task-a', 0, NOW));
    });

    it('starts an idle clock with no task as a task-less timer', () => {
        expect(start({ kind: 'idle' }, undefined, NOW)).toEqual(running('', 0, NOW));
    });

    it('resumes a paused clock on its own task from its seconds', () => {
        expect(start(paused('task-a', 125), undefined, NOW)).toEqual(running('task-a', 125, NOW));
        expect(start(paused('task-a', 125), 'task-a', NOW)).toEqual(running('task-a', 125, NOW));
    });

    it('starts another task from zero', () => {
        expect(start(paused('task-a', 125), 'task-b', NOW)).toEqual(running('task-b', 0, NOW));
        expect(start(running('task-a', 60, secondsAgo(30)), 'task-b', NOW)).toEqual(
            running('task-b', 0, NOW),
        );
    });

    it('hands task-less seconds to the task that starts', () => {
        expect(start(paused('', 45), 'task-a', NOW)).toEqual(running('task-a', 45, NOW));
    });

    it('banks the stretch so far when the running task starts again', () => {
        expect(start(running('task-a', 60, secondsAgo(30)), 'task-a', NOW)).toEqual(
            running('task-a', 90, NOW),
        );
    });
});

describe('pause', () => {
    it('banks the elapsed seconds of a running clock', () => {
        expect(pause(running('task-a', 60, secondsAgo(30)), NOW)).toEqual(paused('task-a', 90));
    });

    it('banks only the base of an expired clock', () => {
        expect(pause(running('task-a', 600, secondsAgo(11 * 60)), NOW)).toEqual(
            paused('task-a', 600),
        );
    });

    it('leaves a paused or idle clock as it is', () => {
        expect(pause(paused('task-a', 125), NOW)).toEqual(paused('task-a', 125));
        expect(pause({ kind: 'idle' }, NOW)).toEqual({ kind: 'idle' });
    });

    it('labels a task-less clock with the task that paused it and keeps a held task', () => {
        expect(pause(running('', 0, secondsAgo(45)), NOW, 'task-b')).toEqual(paused('task-b', 45));
        expect(pause(running('task-a', 0, secondsAgo(45)), NOW, 'task-b')).toEqual(
            paused('task-a', 45),
        );
    });
});

describe('clear and restart', () => {
    it('clears to idle', () => {
        expect(clear()).toEqual({ kind: 'idle' });
    });

    it('restarts a task running from the given seconds', () => {
        expect(restart('task-a', 59, NOW)).toEqual(running('task-a', 59, NOW));
        expect(restart('task-a', 0, NOW)).toEqual(running('task-a', 0, NOW));
    });
});

describe('checkIn', () => {
    it('banks the time so far and restamps the start of a running clock', () => {
        expect(checkIn(running('task-a', 60, secondsAgo(300)), NOW)).toEqual(
            running('task-a', 360, NOW),
        );
    });

    it('writes an expired clock as paused at its base', () => {
        expect(checkIn(running('task-a', 600, secondsAgo(11 * 60)), NOW)).toEqual(
            paused('task-a', 600),
        );
    });

    it('leaves a paused or idle clock as it is', () => {
        expect(checkIn(paused('task-a', 125), NOW)).toEqual(paused('task-a', 125));
        expect(checkIn({ kind: 'idle' }, NOW)).toEqual({ kind: 'idle' });
    });
});
