import { User } from '@/database/user';

/**
 * The work timer as the user record holds it. Nothing ticks on the server. A page adds the time
 * since `since` to `base` itself, so every page shows the same total from the same three fields.
 */
export type Clock =
    | { kind: 'idle' }
    | { kind: 'running'; taskId: string; base: number; since: number }
    | { kind: 'paused'; taskId: string; seconds: number };

/** A page with a running clock banks the time so far and restamps `since` this often. */
export const CHECK_IN_MS = 5 * 60_000;
/** A running clock whose `since` is older than this belongs to a page that died. */
export const EXPIRY_MS = 10 * 60_000;

export type ClockFields = Pick<User, 'timerSeconds' | 'timerStartedAt' | 'timerTaskId'>;

export function clockFrom(user: Partial<ClockFields> | undefined): Clock {
    const {
        timerSeconds = 0,
        timerStartedAt = '',
        timerTaskId = '',
    }: Partial<ClockFields> = user ?? {};
    if (!timerTaskId && !timerSeconds && !timerStartedAt) {
        return { kind: 'idle' };
    }
    const since = Date.parse(timerStartedAt);
    if (Number.isFinite(since)) {
        return { kind: 'running', taskId: timerTaskId, base: timerSeconds, since };
    }
    return { kind: 'paused', taskId: timerTaskId, seconds: timerSeconds };
}

export function toUserFields(clock: Clock): ClockFields {
    switch (clock.kind) {
        case 'idle':
            return { timerSeconds: 0, timerStartedAt: '', timerTaskId: '' };
        case 'paused':
            return { timerSeconds: clock.seconds, timerStartedAt: '', timerTaskId: clock.taskId };
        case 'running':
            return {
                timerSeconds: clock.base,
                timerStartedAt: new Date(clock.since).toISOString(),
                timerTaskId: clock.taskId,
            };
    }
}

/** Whether the two clocks would write the same user fields. */
export function sameClock(a: Clock, b: Clock): boolean {
    const x = toUserFields(a);
    const y = toUserFields(b);
    return (
        x.timerSeconds === y.timerSeconds &&
        x.timerStartedAt === y.timerStartedAt &&
        x.timerTaskId === y.timerTaskId
    );
}

export function isExpired(clock: Clock, now: number): boolean {
    return clock.kind === 'running' && now - clock.since > EXPIRY_MS;
}

export function elapsedSeconds(clock: Clock, now: number): number {
    switch (clock.kind) {
        case 'idle':
            return 0;
        case 'paused':
            return clock.seconds;
        case 'running':
            return isExpired(clock, now)
                ? clock.base
                : clock.base + Math.max(0, Math.floor((now - clock.since) / 1000));
    }
}

/** Starts the given task, or the clock's own. Another task starts from zero. The same task banks the time so far. */
export function start(clock: Clock, taskId: string | undefined, now: number): Clock {
    const held = clock.kind === 'idle' ? '' : clock.taskId;
    const target = taskId || held;
    const base = held && target !== held ? 0 : elapsedSeconds(clock, now);
    return { kind: 'running', taskId: target, base, since: now };
}

/** Pauses a running clock. A task-less clock takes the task of the control that paused it. */
export function pause(clock: Clock, now: number, taskId?: string): Clock {
    if (clock.kind !== 'running') {
        return clock;
    }
    return {
        kind: 'paused',
        taskId: clock.taskId || taskId || '',
        seconds: elapsedSeconds(clock, now),
    };
}

export function clear(): Clock {
    return { kind: 'idle' };
}

/** Banks the time so far and restamps `since`. An expired clock stops at its last check-in. */
export function checkIn(clock: Clock, now: number): Clock {
    if (clock.kind !== 'running') {
        return clock;
    }
    if (isExpired(clock, now)) {
        return { kind: 'paused', taskId: clock.taskId, seconds: clock.base };
    }
    return { kind: 'running', taskId: clock.taskId, base: elapsedSeconds(clock, now), since: now };
}
