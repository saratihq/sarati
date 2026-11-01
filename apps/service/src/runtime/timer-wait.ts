import { EVENT_TOPIC_PREFIX, isStepTopic } from './event-wait';

/**
 * A wait that ends by the clock rather than by someone acting.
 *
 * It parks exactly like a human-in-the-loop wait — the run leaves flight, so the wall-clock cap that
 * reaps a stuck run does not apply to one that is deliberately asleep. The topic is reserved: no
 * caller can send to it, and its own timeout IS the wake.
 */
const TIMER_TOPIC_PREFIX = 'orchestr:timer:';

export function timerTopicFor(stepKey: string): string {
  return `${TIMER_TOPIC_PREFIX}${stepKey}`;
}

/** Whether a parked run is asleep on purpose (wakes itself) rather than waiting on a person. */
export function isTimerWait(topic: string | null | undefined): boolean {
  return typeof topic === 'string' && topic.startsWith(TIMER_TOPIC_PREFIX);
}

/** Refuses a wait-for-event on a reserved topic: a timer's, which nobody can answer, or one spelled like a step's own receive. */
export function assertAnswerableTopic(step: string, topic: string): void {
  if (isTimerWait(topic)) {
    throw new Error(
      `Wait for event "${step}" can't use the topic "${topic}" — it is reserved for timed waits`,
    );
  }
  if (isStepTopic(topic)) {
    throw new Error(
      `Wait for event "${step}" can't use the topic "${topic}" — topics starting "${EVENT_TOPIC_PREFIX}" are reserved`,
    );
  }
}

/** SQL-side form of {@link isTimerWait}, for set-based queries (the reaper, the approvals inbox). */
export const TIMER_TOPIC_SQL_PREFIX = TIMER_TOPIC_PREFIX;

/** Below this a delay just sleeps in place: parking costs two writes and buys nothing. */
export const PARK_DELAY_ABOVE_MS = 60_000;

/** How often a parked wait reads the wall clock, so one whose deadline a suspend or a clock step passed wakes within a poll. */
export const WAKE_POLL_MS = 10_000;
