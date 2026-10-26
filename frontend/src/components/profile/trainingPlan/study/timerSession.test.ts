import { Clock } from '@/components/timer/clock';
import { describe, expect, it } from 'vitest';
import { deduct, finish, foreignClock, harvest, Session, sessionFor } from './timerSession';

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
const nobody: Session = { kind: 'attached', pausedBy: 'nobody' };
const member: Session = { kind: 'attached', pausedBy: 'member' };
const reader: Session = { kind: 'attached', pausedBy: 'reader' };
const done: Session = { kind: 'attached', pausedBy: 'done' };

describe('sessionFor', () => {
    it('is foreign while the clock is on another task, whatever it did last', () => {
        expect(sessionFor(running('task-b', 0, NOW), 'task-a', true, undefined)).toEqual({
            kind: 'foreign',
        });
        expect(sessionFor(paused('task-b', 30), 'task-a', false, reader)).toEqual({
            kind: 'foreign',
        });
    });

    it('is attached by nobody while the clock runs on the task', () => {
        expect(sessionFor(running('task-a', 0, NOW), 'task-a', true, undefined)).toEqual(nobody);
        expect(sessionFor(running('task-a', 0, NOW), 'task-a', true, reader)).toEqual(nobody);
    });

    it('is attached while the clock has no task, as the navbar can start one', () => {
        expect(sessionFor(running('', 0, NOW), 'task-a', true, undefined)).toEqual(nobody);
        expect(sessionFor(paused('', 30), 'task-a', false, undefined)).toEqual(member);
    });

    it('is paused by the member when the clock is idle or paused and the reader did not pause it', () => {
        expect(sessionFor(idle, 'task-a', false, undefined)).toEqual(member);
        expect(sessionFor(paused('task-a', 30), 'task-a', false, nobody)).toEqual(member);
        expect(sessionFor(paused('task-a', 30), 'task-a', false, member)).toEqual(member);
        expect(sessionFor(paused('task-a', 30), 'task-a', false, { kind: 'foreign' })).toEqual(
            member,
        );
    });

    it('stays paused by the reader until the clock runs again', () => {
        expect(sessionFor(paused('task-a', 30), 'task-a', false, reader)).toEqual(reader);
        expect(sessionFor(idle, 'task-a', false, reader)).toEqual(reader);
    });

    it('keeps a Done stop while the clock stays paused, and drops it once the member clears the clock or it runs', () => {
        expect(sessionFor(paused('task-a', 30), 'task-a', false, done)).toEqual(done);
        expect(sessionFor(paused('', 30), 'task-a', false, done)).toEqual(done);
        expect(sessionFor(idle, 'task-a', false, done)).toEqual(member);
        expect(sessionFor(running('task-a', 30, NOW), 'task-a', true, done)).toEqual(nobody);
    });

    it('reads an expired running clock as paused, by whoever paused last', () => {
        const expired = running('task-a', 600, secondsAgo(11 * 60));
        expect(sessionFor(expired, 'task-a', false, nobody)).toEqual(member);
        expect(sessionFor(expired, 'task-a', false, reader)).toEqual(reader);
    });
});

describe('harvest and deduct', () => {
    it('posts the whole minutes of a running clock and keeps the remainder running from now', () => {
        expect(harvest(running('task-a', 479, NOW), 'task-a', NOW)).toEqual({
            minutes: 7,
            next: running('task-a', 59, NOW),
        });
        expect(harvest(running('task-a', 400, secondsAgo(79)), 'task-a', NOW)).toEqual({
            minutes: 7,
            next: running('task-a', 59, NOW),
        });
    });

    it('posts the whole minutes of a paused clock and keeps the remainder paused', () => {
        expect(harvest(paused('task-a', 125), 'task-a', NOW)).toEqual({
            minutes: 2,
            next: paused('task-a', 5),
        });
    });

    it('counts the minutes of a clock running without a task', () => {
        expect(harvest(running('', 479, NOW), 'task-a', NOW)).toEqual({
            minutes: 7,
            next: running('', 59, NOW),
        });
    });

    it('posts nothing for an idle clock and leaves it idle', () => {
        expect(harvest(idle, 'task-a', NOW)).toEqual({ minutes: 0, next: idle });
        expect(deduct(idle, 'task-a', 0, NOW)).toEqual(idle);
    });

    it('posts the banked time of an expired clock and restamps it from now', () => {
        expect(harvest(running('task-a', 600, secondsAgo(11 * 60)), 'task-a', NOW)).toEqual({
            minutes: 10,
            next: running('task-a', 0, NOW),
        });
    });

    it("neither counts nor touches another task's clock", () => {
        expect(harvest(running('task-b', 479, NOW), 'task-a', NOW)).toBeUndefined();
        expect(harvest(paused('task-b', 125), 'task-a', NOW)).toBeUndefined();
        expect(deduct(paused('task-b', 125), 'task-a', 2, NOW)).toBeUndefined();
    });

    it('keeps a minute crossed during the post when it deducts the posted minutes', () => {
        const atPost = running('task-a', 60, secondsAgo(65));
        expect(deduct(atPost, 'task-a', 1, NOW)).toEqual(running('task-a', 65, NOW));
        expect(deduct(paused('task-a', 125), 'task-a', 2, NOW)).toEqual(paused('task-a', 5));
    });

    it('never deducts below zero', () => {
        expect(deduct(paused('task-a', 100), 'task-a', 2, NOW)).toEqual(paused('task-a', 0));
        expect(deduct(running('task-a', 100, NOW), 'task-a', 2, NOW)).toEqual(
            running('task-a', 0, NOW),
        );
    });
});

describe('finish', () => {
    it('posts the whole minutes of a running clock and stops it with the remainder', () => {
        expect(finish(running('task-a', 150, NOW), 'task-a', 2, NOW)).toEqual(paused('task-a', 30));
        expect(finish(running('task-a', 100, secondsAgo(50)), 'task-a', 2, NOW)).toEqual(
            paused('task-a', 30),
        );
    });

    it('takes the minutes off a paused clock and leaves it paused', () => {
        expect(finish(paused('task-a', 125), 'task-a', 2, NOW)).toEqual(paused('task-a', 5));
    });

    it('stops the clock for zero minutes', () => {
        expect(finish(running('task-a', 30, NOW), 'task-a', 0, NOW)).toEqual(paused('task-a', 30));
        expect(finish(paused('task-a', 30), 'task-a', 0, NOW)).toEqual(paused('task-a', 30));
    });

    it('never stops below zero', () => {
        expect(finish(running('task-a', 100, NOW), 'task-a', 2, NOW)).toEqual(paused('task-a', 0));
    });

    it('puts a clock without a task onto the task it stops on', () => {
        expect(finish(running('', 150, NOW), 'task-a', 2, NOW)).toEqual(paused('task-a', 30));
        expect(finish(paused('', 125), 'task-a', 2, NOW)).toEqual(paused('task-a', 5));
    });

    it('stops an expired clock at its last check-in, minus the minutes', () => {
        expect(finish(running('task-a', 100, secondsAgo(700)), 'task-a', 1, NOW)).toEqual(
            paused('task-a', 40),
        );
    });

    it('has nothing to stop on an idle clock', () => {
        expect(finish(idle, 'task-a', 0, NOW)).toBeUndefined();
    });

    it("leaves another task's clock alone", () => {
        expect(finish(running('task-b', 150, NOW), 'task-a', 2, NOW)).toBeUndefined();
        expect(finish(paused('task-b', 150), 'task-a', 2, NOW)).toBeUndefined();
    });
});

describe('foreignClock', () => {
    it('names the other task and its whole minutes, running or paused', () => {
        expect(foreignClock(running('task-b', 1_380, secondsAgo(15)), 'task-a', NOW)).toEqual({
            taskId: 'task-b',
            minutes: 23,
        });
        expect(foreignClock(paused('task-b', 40), 'task-a', NOW)).toEqual({
            taskId: 'task-b',
            minutes: 0,
        });
    });

    it('counts an expired clock at its last check-in', () => {
        expect(foreignClock(running('task-b', 600, secondsAgo(700)), 'task-a', NOW)).toEqual({
            taskId: 'task-b',
            minutes: 10,
        });
    });

    it('is undefined for a clock that is idle, without a task, or on the task', () => {
        expect(foreignClock(idle, 'task-a', NOW)).toBeUndefined();
        expect(foreignClock(running('', 600, NOW), 'task-a', NOW)).toBeUndefined();
        expect(foreignClock(paused('task-a', 600), 'task-a', NOW)).toBeUndefined();
    });
});
