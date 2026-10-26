import { Clock, elapsedSeconds, pause } from '@/components/timer/clock';

/**
 * The reader's relation to the work timer. A clock on another task is foreign and the reader
 * leaves it alone. A session another tab took is handed off, and this tab leaves the clock to
 * that tab. An attached clock is idle, without a task, or on the reader's task, and whoever
 * paused it last decides who resumes it. A stop from Done lifts when another game of the task
 * opens.
 */
export type Session =
    | { kind: 'foreign' }
    | { kind: 'handed-off' }
    | { kind: 'attached'; pausedBy: 'nobody' | 'member' | 'reader' | 'done' };

/** A hidden tab keeps the clock running this long before the reader pauses it. */
export const HIDDEN_GRACE_MS = 60_000;

/** A clock the navbar started without a task is on whichever task the reader is on. */
function onTask(clock: Clock, taskId: string): boolean {
    return clock.kind === 'idle' || !clock.taskId || clock.taskId === taskId;
}

/**
 * The session the reader is in, given the clock and what it did last. `running` is the provider's
 * view, which is false for an expired clock, so an expired clock counts as paused here.
 */
export function sessionFor(
    clock: Clock,
    taskId: string,
    running: boolean,
    previous: Session | undefined,
): Session {
    if (!onTask(clock, taskId)) {
        return { kind: 'foreign' };
    }
    if (running) {
        return { kind: 'attached', pausedBy: 'nobody' };
    }
    const held = previous?.kind === 'attached' ? previous.pausedBy : undefined;
    // A clock the member cleared from the navbar is idle, so the Done stop no longer applies.
    if (held === 'reader' || (held === 'done' && clock.kind === 'paused')) {
        return { kind: 'attached', pausedBy: held };
    }
    return { kind: 'attached', pausedBy: 'member' };
}

function deducted(clock: Clock, minutes: number, now: number): Clock {
    switch (clock.kind) {
        case 'idle':
            return clock;
        case 'running':
            return {
                kind: 'running',
                taskId: clock.taskId,
                base: Math.max(0, elapsedSeconds(clock, now) - minutes * 60),
                since: now,
            };
        case 'paused':
            return {
                kind: 'paused',
                taskId: clock.taskId,
                seconds: Math.max(0, clock.seconds - minutes * 60),
            };
    }
}

/**
 * The clock after a mark posted `minutes` whole minutes, in the same run state. Undefined when
 * the clock is on another task.
 */
export function deduct(
    clock: Clock,
    taskId: string,
    minutes: number,
    now: number,
): Clock | undefined {
    return onTask(clock, taskId) ? deducted(clock, minutes, now) : undefined;
}

/**
 * The clock after a mark posted `minutes` whole minutes and stopped it, paused with the
 * remainder. Undefined when the clock is on another task or idle, as there is nothing to stop
 * and nothing to write.
 */
export function finish(
    clock: Clock,
    taskId: string,
    minutes: number,
    now: number,
): Clock | undefined {
    if (!onTask(clock, taskId) || clock.kind === 'idle') {
        return undefined;
    }
    const stopped = pause(deducted(clock, minutes, now), now, taskId);
    // A clock paused without a task stops on the reader's task, as a running one does.
    return stopped.kind === 'paused' ? { ...stopped, taskId: stopped.taskId || taskId } : undefined;
}

/**
 * The task a foreign clock is on and the whole minutes it holds, for the banner and the switch.
 * Undefined when the clock is attached.
 */
export function foreignClock(
    clock: Clock,
    taskId: string,
    now: number,
): { taskId: string; minutes: number } | undefined {
    if (clock.kind === 'idle' || onTask(clock, taskId)) {
        return undefined;
    }
    return { taskId: clock.taskId, minutes: Math.floor(elapsedSeconds(clock, now) / 60) };
}

/**
 * Whole minutes to post for a mark, and the clock to write afterwards. The mark posts the
 * minutes first and writes the clock after its await, through `deduct` with the same minutes,
 * so a minute that passed during the post stays on the clock.
 */
export function harvest(
    clock: Clock,
    taskId: string,
    now: number,
): { minutes: number; next: Clock } | undefined {
    if (!onTask(clock, taskId)) {
        return undefined;
    }
    const minutes = Math.floor(elapsedSeconds(clock, now) / 60);
    return { minutes, next: deducted(clock, minutes, now) };
}
