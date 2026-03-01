import type { StarciteSession } from "@starcite/sdk";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

export type SendMessagesOptions = Parameters<
  ChatTransport<UIMessage>["sendMessages"]
>[0];
export type ReconnectToStreamOptions = Parameters<
  ChatTransport<UIMessage>["reconnectToStream"]
>[0];

export type ChatChunk = UIMessageChunk;

export interface StarciteChatTransportOptions {
  /**
   * Starcite session bound to this transport. Created server-side with an
   * API key, then reconstructed on the frontend from the session token via
   * `starcite.session({ token })`.
   */
  session: StarciteSession;
}
