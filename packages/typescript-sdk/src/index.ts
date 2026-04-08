/* biome-ignore-all lint/performance/noBarrelFile: package entrypoint intentionally re-exports public API. */
export { createStarcite, Starcite } from "./client";
export type { StarciteConfig, StarciteConfigInput } from "./config";
export { getStarciteConfig, resolveStarciteConfig } from "./config";
export type { StarciteTailErrorStage } from "./errors";
export {
  StarciteApiError,
  StarciteConnectionError,
  StarciteError,
  StarciteTailError,
  StarciteTokenExpiredError,
} from "./errors";
export type { PrincipalType } from "./identity";
export { StarciteIdentity } from "./identity";
export { StarciteSession } from "./session";
export type {
  SessionStoreOptions,
  StarciteWebStorage,
  WebStorageSessionStoreOptions,
} from "./session-store";
export {
  LocalStorageSessionStore,
  MemoryStore,
  WebStorageSessionStore,
} from "./session-store";
export type {
  AppendEventRequest,
  AppendEventResponse,
  AppendResult,
  LifecycleEventEnvelope,
  RequestOptions,
  SessionActivatedLifecycleEvent,
  SessionAppendFailureSnapshot,
  SessionAppendInput,
  SessionAppendLifecycleEvent,
  SessionAppendListener,
  SessionAppendOptions,
  SessionAppendQueueState,
  SessionAppendQueueStatus,
  SessionAppendRetryPolicy,
  SessionCreatedLifecycleEvent,
  SessionEventContext,
  SessionEventListener,
  SessionEventPhase,
  SessionFreezingLifecycleEvent,
  SessionFrozenLifecycleEvent,
  SessionGapListener,
  SessionHydratingLifecycleEvent,
  SessionLifecycleEvent,
  SessionLifecycleEventName,
  SessionListItem,
  SessionListOptions,
  SessionListPage,
  SessionOnEventOptions,
  SessionRecord,
  SessionSnapshot,
  SessionStore,
  SessionStoredAppend,
  SessionStoreMetadata,
  SessionStoreState,
  SessionTokenRefreshContext,
  SessionTokenRefreshHandler,
  SessionTokenRefreshReason,
  StarciteOptions,
  TailCursor,
  TailEvent,
  TailGap,
} from "./types";
