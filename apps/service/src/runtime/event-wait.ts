const EVENT_TOPIC_PREFIX = 'orchestr:wait:';

/** The DBOS topic a wait-for-event step receives on — its own, so two waits on one topic never share a receive. */
export function eventTopicFor(stepKey: string): string {
  return `${EVENT_TOPIC_PREFIX}${stepKey}`;
}
