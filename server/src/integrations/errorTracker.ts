import * as Sentry from '@sentry/node';

export type ErrorContext = Record<string, string | number | boolean | null | undefined>;

export interface ErrorTracker {
  capture(error: unknown, context?: ErrorContext): void;
  flush(timeoutMs: number): Promise<void>;
}

export const noopErrorTracker: ErrorTracker = {
  capture: () => undefined,
  flush: async () => undefined,
};

let activeTracker: ErrorTracker = noopErrorTracker;

export function errorTracker(): ErrorTracker {
  return activeTracker;
}

export function setErrorTracker(tracker: ErrorTracker): void {
  activeTracker = tracker;
}

type SentryEvent = Parameters<NonNullable<Sentry.NodeOptions['beforeSend']>>[0];

export function scrubEvent<T extends SentryEvent>(event: T): T {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
  }
  if (event.user) {
    event.user = event.user.id ? { id: event.user.id } : undefined;
  }
  return event;
}

export interface SentryOptions {
  dsn: string;
  release: string | null;
  environment: string;
}

export function createSentryTracker({ dsn, release, environment }: SentryOptions): ErrorTracker {
  Sentry.init({
    dsn,
    environment,
    release: release ?? undefined,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    tracesSampleRate: 0,
    beforeSend: event => scrubEvent(event),
  });
  return {
    capture: (error, context = {}) => {
      Sentry.withScope(scope => {
        const { userId, ...tags } = context;
        for (const [key, value] of Object.entries(tags)) {
          if (value !== undefined && value !== null) {
            scope.setTag(key, String(value));
          }
        }
        if (typeof userId === 'string') {
          scope.setUser({ id: userId });
        }
        Sentry.captureException(error);
      });
    },
    flush: async timeoutMs => {
      await Sentry.flush(timeoutMs);
    },
  };
}
