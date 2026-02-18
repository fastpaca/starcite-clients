import {
  createStarciteClient,
  type CreateSessionInput,
  type StarciteClient,
  type StarcitePayload,
} from "@starcite/sdk";
import type { UIMessageChunk } from "ai";

interface UserMessagePayload extends StarcitePayload {
  text: string;
}

type ChunkPayload = UIMessageChunk & StarcitePayload;
type CreatorPrincipal = NonNullable<CreateSessionInput["creator_principal"]>;

export type DemoPayload = UserMessagePayload | ChunkPayload;

const DEFAULT_STARCITE_BASE_URL =
  typeof window !== "undefined"
    ? window.location.origin
    : "http://localhost:45187";

function getEnv(name: string): string | undefined {
  const value = import.meta.env[name];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function getDemoCreatorPrincipal(): CreatorPrincipal | undefined {
  const tenantId = getEnv("VITE_STARCITE_CREATOR_TENANT_ID");
  const principalId = getEnv("VITE_STARCITE_CREATOR_ID");
  const principalType = getEnv("VITE_STARCITE_CREATOR_TYPE");

  if (!tenantId || !principalId) {
    return undefined;
  }

  return {
    tenant_id: tenantId,
    id: principalId,
    type: principalType === "agent" ? "agent" : "user",
  };
}

export function createDemoStarciteClient(): StarciteClient<DemoPayload> {
  const baseUrl =
    getEnv("VITE_STARCITE_BASE_URL") ?? DEFAULT_STARCITE_BASE_URL;
  const apiKey = getEnv("VITE_STARCITE_API_KEY");

  return createStarciteClient<DemoPayload>({
    baseUrl,
    apiKey,
  });
}
