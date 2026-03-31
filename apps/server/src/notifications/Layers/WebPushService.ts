import type { WebPushConfig } from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path, Ref, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";
import webPush from "web-push";
import { ServerConfig } from "../../config";
import {
  WebPushService,
  WebPushServiceError,
  type WebPushServiceShape,
} from "../Services/WebPushService";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

const DEFAULT_VAPID_SUBJECT = "mailto:notifications@example.com";

const StoredWebPushSubscription = Schema.Struct({
  endpoint: Schema.String,
  expirationTime: Schema.NullOr(Schema.Number),
  keys: Schema.Struct({
    p256dh: Schema.String,
    auth: Schema.String,
  }),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
type StoredWebPushSubscription = typeof StoredWebPushSubscription.Type;

const WebPushState = Schema.Struct({
  vapidSubject: Schema.String,
  vapidPublicKey: Schema.String,
  vapidPrivateKey: Schema.String,
  subscriptions: Schema.Array(StoredWebPushSubscription),
});
type WebPushState = typeof WebPushState.Type;

const WebPushStateJson = fromLenientJson(WebPushState);

class WebPushDispatchError extends Schema.TaggedErrorClass<WebPushDispatchError>()(
  "WebPushDispatchError",
  {
    detail: Schema.String,
    statusCode: Schema.NullOr(Schema.Number),
    cause: Schema.optional(Schema.Defect),
  },
) {}

const makeWebPushService = Effect.gen(function* () {
  const { webPushStatePath, webPushVapidSubject } = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const startSemaphore = yield* Semaphore.make(1);
  const writeSemaphore = yield* Semaphore.make(1);
  const stateRef = yield* Ref.make<WebPushState | null>(null);
  const startedRef = yield* Ref.make(false);
  const configuredVapidSubject = webPushVapidSubject ?? DEFAULT_VAPID_SUBJECT;

  const fail = (detail: string, cause?: unknown) =>
    new WebPushServiceError({
      detail,
      statePath: webPushStatePath,
      ...(cause !== undefined ? { cause } : {}),
    });

  const readStateRef = Effect.flatMap(Ref.get(stateRef), (state) =>
    state ? Effect.succeed(state) : Effect.fail(fail("service was used before initialization")),
  );

  const writeStateToDisk = (state: WebPushState) => {
    const tempPath = `${webPushStatePath}.${process.pid}.${Date.now()}.tmp`;
    return Effect.succeed(`${JSON.stringify(state, null, 2)}\n`).pipe(
      Effect.tap(() =>
        fileSystem.makeDirectory(path.dirname(webPushStatePath), { recursive: true }),
      ),
      Effect.tap((encoded) => fileSystem.writeFileString(tempPath, encoded)),
      Effect.flatMap(() => fileSystem.rename(tempPath, webPushStatePath)),
      Effect.ensuring(
        fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true })),
      ),
      Effect.mapError((cause) => fail("failed to write persisted web push state", cause)),
    );
  };

  const createFreshState = Effect.gen(function* () {
    const keys = webPush.generateVAPIDKeys();
    const nextState: WebPushState = {
      vapidSubject: configuredVapidSubject,
      vapidPublicKey: keys.publicKey,
      vapidPrivateKey: keys.privateKey,
      subscriptions: [],
    };
    yield* writeStateToDisk(nextState);
    return nextState;
  });

  const loadStateFromDisk = Effect.gen(function* () {
    const exists = yield* fileSystem
      .exists(webPushStatePath)
      .pipe(Effect.mapError((cause) => fail("failed to check persisted web push state", cause)));
    if (!exists) {
      return yield* createFreshState;
    }

    const raw = yield* fileSystem
      .readFileString(webPushStatePath)
      .pipe(Effect.mapError((cause) => fail("failed to read persisted web push state", cause)));
    const decoded = Schema.decodeUnknownExit(WebPushStateJson)(raw);
    if (decoded._tag === "Success") {
      if (decoded.value.vapidSubject === configuredVapidSubject) {
        return decoded.value;
      }
      const migratedState: WebPushState = {
        ...decoded.value,
        vapidSubject: configuredVapidSubject,
      };
      yield* writeStateToDisk(migratedState);
      return migratedState;
    }

    yield* Effect.logWarning("failed to parse web push state, regenerating", {
      path: webPushStatePath,
    });
    return yield* createFreshState;
  });

  const ensureStarted = startSemaphore.withPermits(1)(
    Effect.gen(function* () {
      if (yield* Ref.get(startedRef)) {
        return;
      }
      const state = yield* loadStateFromDisk;
      yield* Ref.set(stateRef, state);
      yield* Ref.set(startedRef, true);
    }),
  );

  const persistState = (state: WebPushState) =>
    writeSemaphore.withPermits(1)(
      writeStateToDisk(state).pipe(Effect.tap(() => Ref.set(stateRef, state))),
    );

  const updateSubscriptions = (
    transform: (
      subscriptions: ReadonlyArray<StoredWebPushSubscription>,
    ) => ReadonlyArray<StoredWebPushSubscription>,
  ) =>
    Effect.gen(function* () {
      yield* ensureStarted;
      const state = yield* readStateRef;
      const nextState: WebPushState = {
        ...state,
        subscriptions: [...transform(state.subscriptions)],
      };
      yield* persistState(nextState);
    });

  const removeSubscriptionEndpoints = (endpoints: ReadonlySet<string>) =>
    endpoints.size === 0
      ? Effect.void
      : updateSubscriptions((subscriptions) =>
          subscriptions.filter((subscription) => !endpoints.has(subscription.endpoint)),
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to prune stale web push subscriptions", { error }),
          ),
        );

  const getVapidConfig = Effect.gen(function* () {
    yield* ensureStarted;
    const state = yield* readStateRef;
    return {
      vapidPublicKey: state.vapidPublicKey,
    } satisfies WebPushConfig;
  });

  const sendThreadCompletionNotification = (payload: {
    readonly title: string;
    readonly body: string;
    readonly tag: string;
    readonly urlPath: string;
  }) =>
    Effect.gen(function* () {
      yield* ensureStarted;
      const state = yield* readStateRef;
      if (state.subscriptions.length === 0) {
        yield* Effect.logInfo("skipping web push notification: no active subscriptions", {
          tag: payload.tag,
          title: payload.title,
          urlPath: payload.urlPath,
        });
        return;
      }

      const staleEndpoints = new Set<string>();
      const serializedPayload = JSON.stringify(payload);

      yield* Effect.logInfo("dispatching web push notification", {
        tag: payload.tag,
        title: payload.title,
        urlPath: payload.urlPath,
        subscriptionCount: state.subscriptions.length,
      });

      yield* Effect.forEach(
        state.subscriptions,
        (subscription) =>
          Effect.tryPromise({
            try: () =>
              webPush.sendNotification(subscription as any, serializedPayload, {
                TTL: 60,
                vapidDetails: {
                  subject: state.vapidSubject,
                  publicKey: state.vapidPublicKey,
                  privateKey: state.vapidPrivateKey,
                },
              }),
            catch: (cause) =>
              new WebPushDispatchError({
                detail: "failed to send web push notification",
                statusCode:
                  typeof cause === "object" &&
                  cause !== null &&
                  "statusCode" in cause &&
                  typeof cause.statusCode === "number"
                    ? cause.statusCode
                    : null,
                cause,
              }),
          }).pipe(
            Effect.tap((response) =>
              Effect.logInfo("web push notification delivered to endpoint", {
                endpoint: subscription.endpoint,
                statusCode:
                  typeof response === "object" &&
                  response !== null &&
                  "statusCode" in response &&
                  typeof response.statusCode === "number"
                    ? response.statusCode
                    : null,
                tag: payload.tag,
              }),
            ),
            Effect.catch((error) => {
              if (error.statusCode === 404 || error.statusCode === 410) {
                staleEndpoints.add(subscription.endpoint);
                return Effect.logWarning("web push subscription expired; pruning endpoint", {
                  endpoint: subscription.endpoint,
                  statusCode: error.statusCode,
                  tag: payload.tag,
                });
              }
              return Effect.logWarning("failed to send web push notification", {
                endpoint: subscription.endpoint,
                error,
                tag: payload.tag,
              });
            }),
          ),
        { concurrency: 4, discard: true },
      );

      if (staleEndpoints.size > 0) {
        yield* Effect.logInfo("pruning stale web push subscriptions", {
          count: staleEndpoints.size,
          endpoints: [...staleEndpoints],
        });
      }

      yield* removeSubscriptionEndpoints(staleEndpoints);
      yield* Effect.logInfo("finished web push notification dispatch", {
        tag: payload.tag,
        title: payload.title,
        urlPath: payload.urlPath,
        subscriptionCount: state.subscriptions.length,
        staleSubscriptionCount: staleEndpoints.size,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("web push notification dispatch failed", { cause }),
      ),
    );

  return {
    start: ensureStarted,
    getWebPushConfig: getVapidConfig,
    upsertWebPushSubscription: (input) =>
      Effect.gen(function* () {
        yield* ensureStarted;
        const now = new Date().toISOString();
        yield* updateSubscriptions((subscriptions) => {
          const existing = subscriptions.find(
            (subscription) => subscription.endpoint === input.endpoint,
          );
          const nextSubscription: StoredWebPushSubscription = {
            endpoint: input.endpoint,
            expirationTime: input.expirationTime ?? null,
            keys: input.keys,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          return [
            ...subscriptions.filter((subscription) => subscription.endpoint !== input.endpoint),
            nextSubscription,
          ];
        });
      }),
    removeWebPushSubscription: (input) =>
      Effect.gen(function* () {
        yield* ensureStarted;
        yield* updateSubscriptions((subscriptions) =>
          subscriptions.filter((subscription) => subscription.endpoint !== input.endpoint),
        );
      }),
    sendThreadCompletionNotification: (payload) =>
      sendThreadCompletionNotification({
        title: payload.title,
        body: payload.body,
        tag: payload.tag,
        urlPath: payload.urlPath,
      }),
  } satisfies WebPushServiceShape;
});

export const WebPushServiceLive = Layer.effect(WebPushService, makeWebPushService);
