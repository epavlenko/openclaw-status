/**
 * Status Backend client — TypeScript port of status_client.py
 *
 * Wraps status-backend HTTP + WebSocket API.
 * See AGENTS.md for startup sequence and gotchas.
 */

export class StatusBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatusBackendError";
  }
}

export interface StatusClientConfig {
  baseUrl: string;
}

export interface RpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface ChatMessage {
  id: string;
  chatId: string;
  text: string;
  from: string;
  timestamp: number;
  contentType: number;
}

export interface Contact {
  id: string;
  displayName?: string;
  hasAddedUs?: boolean;
  added?: boolean;
}

export interface Community {
  id: string;
  name?: string;
  joined?: boolean;
  isMember?: boolean;
}

export type SignalHandler = (type: string, event: Record<string, unknown>) => Promise<void>;

export class StatusClient {
  private baseUrl: string;
  private rpcId = 0;

  constructor(config: StatusClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
  }

  // --- HTTP API ---

  async health(): Promise<Record<string, unknown>> {
    const r = await fetch(`${this.baseUrl}/health`);
    return r.json() as Promise<Record<string, unknown>>;
  }

  async initialize(dataDir: string): Promise<Record<string, unknown>> {
    return this.post("/statusgo/InitializeApplication", {
      dataDir,
      logEnabled: true,
      logLevel: "DEBUG",
    });
  }

  async createAccount(displayName: string, password: string, dataDir: string): Promise<Record<string, unknown>> {
    return this.post("/statusgo/CreateAccountAndLogin", {
      rootDataDir: dataDir,
      displayName,
      password,
      customizationColor: "primary",
    });
  }

  async login(keyUID: string, password: string): Promise<Record<string, unknown>> {
    return this.post("/statusgo/LoginAccount", { keyUID, password });
  }

  async callRpc(method: string, params: unknown[] = []): Promise<RpcResponse> {
    this.rpcId += 1;
    return this.post("/statusgo/CallRPC", {
      jsonrpc: "2.0",
      id: this.rpcId,
      method,
      params,
    }) as unknown as Promise<RpcResponse>;
  }

  async startMessenger(): Promise<RpcResponse> {
    return this.callRpc("wakuext_startMessenger");
  }

  async getSettings(): Promise<Record<string, unknown>> {
    const r = await this.callRpc("settings_getSettings");
    return (r.result as Record<string, unknown>) ?? {};
  }

  async joinedCommunities(): Promise<Community[]> {
    const r = await this.callRpc("wakuext_joinedCommunities");
    return (r.result as Community[]) ?? [];
  }

  async fetchCommunity(communityKey: string): Promise<RpcResponse> {
    return this.callRpc("wakuext_fetchCommunity", [{
      communityKey,
      tryDatabase: true,
      waitForResponse: true,
    }]);
  }

  /**
   * Spectate a community — subscribes to its Waku pubsub topics without joining.
   * MUST be called before requestToJoinCommunity, otherwise the join request
   * won't be delivered to the community control node.
   */
  async spectateCommunity(communityId: string): Promise<RpcResponse> {
    return this.callRpc("wakuext_spectateCommunity", [communityId]);
  }

  async getAccounts(): Promise<Array<{ wallet?: boolean; address: string }>> {
    const r = await this.callRpc("accounts_getAccounts");
    return (r.result as Array<{ wallet?: boolean; address: string }>) ?? [];
  }

  /**
   * Join an open community directly.
   * For closed communities, use requestToJoinCommunity instead.
   */
  async joinCommunity(communityId: string): Promise<RpcResponse> {
    return this.callRpc("wakuext_joinCommunity", [communityId]);
  }

  /**
   * Request to join a closed community (requires owner approval).
   */
  async requestToJoinCommunity(communityId: string): Promise<RpcResponse> {
    const accounts = await this.getAccounts();
    const walletAddr = accounts.find((a) => a.wallet)?.address ?? "";

    return this.callRpc("wakuext_requestToJoinCommunity", [{
      communityId,
      ...(walletAddr ? { addressesToReveal: [walletAddr], airdropAddress: walletAddr } : {}),
    }]);
  }

  async sendChatMessage(chatId: string, text: string): Promise<RpcResponse> {
    return this.callRpc("wakuext_sendChatMessage", [{
      chatId,
      text,
      contentType: 1, // text message
    }]);
  }

  async chatMessages(chatId: string, cursor = "", limit = 20): Promise<RpcResponse> {
    return this.callRpc("wakuext_chatMessages", [chatId, cursor, limit]);
  }

  async acceptContactRequest(contactId: string): Promise<RpcResponse> {
    return this.callRpc("wakuext_acceptLatestContactRequestForContact", [{ id: contactId }]);
  }

  async acceptAllPendingContactRequests(): Promise<number> {
    const r = await this.callRpc("wakuext_contacts");
    const contacts: Contact[] = (r.result as Contact[]) ?? [];
    let accepted = 0;
    for (const c of contacts) {
      if (c.hasAddedUs && !c.added) {
        await this.acceptContactRequest(c.id);
        accepted++;
      }
    }
    return accepted;
  }

  async acceptCommunityInvitations(): Promise<number> {
    // Type 6 = community invitation
    const r = await this.callRpc("wakuext_activityCenterNotifications", [{
      activityTypes: [6],
      cursor: "",
      limit: 50,
      readType: 1,
    }]);
    const notifications: Array<{ communityId?: string; id: string }> =
      ((r.result as Record<string, unknown>)?.activityCenterNotifications as Record<string, unknown>)
        ?.notifications as Array<{ communityId?: string; id: string }> ?? [];

    let accepted = 0;
    for (const n of notifications) {
      if (n.communityId) {
        await this.callRpc("wakuext_acceptActivityCenterNotifications", [{ ids: [n.id] }]);
        accepted++;
      }
    }

    if (notifications.length === 0) {
      // Check for communities we can see but haven't joined
      const cr = await this.callRpc("wakuext_communities");
      const communities: Community[] = (cr.result as Community[]) ?? [];
      for (const c of communities) {
        if (!c.joined && c.isMember && c.id) {
          const accts = await this.callRpc("accounts_getAccounts");
          const accounts = (accts.result as Array<{ wallet?: boolean; address: string }>) ?? [];
          const walletAddr = accounts.find((a) => a.wallet)?.address ?? "";
          if (walletAddr) {
            await this.callRpc("wakuext_requestToJoinCommunity", [{
              communityId: c.id,
              addressesToReveal: [walletAddr],
              airdropAddress: walletAddr,
            }]);
            accepted++;
          }
        }
      }
    }

    return accepted;
  }

  // --- WebSocket Signals ---

  /**
   * Connect to WebSocket signals endpoint and dispatch to handler.
   * Auto-reconnects on disconnect.
   *
   * IMPORTANT: status-backend does NOT respond to WS pings.
   * Use ping: false / no keepalive in the WebSocket client.
   */
  async listenSignals(handler: SignalHandler): Promise<void> {
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/signals";

    const connect = async () => {
      const ws = new WebSocket(wsUrl);

      ws.onmessage = async (event: MessageEvent) => {
        try {
          const signal = JSON.parse(event.data as string) as { type?: string; event?: Record<string, unknown> };
          const type = signal.type ?? "";
          const evt = signal.event ?? {};
          if (type !== "wakuv2.peerstats") {
            console.log(`[status] Signal: ${type}`);
          }
          await handler(type, evt);
        } catch (err) {
          console.warn("[status] Failed to parse signal:", err);
        }
      };

      ws.onclose = () => {
        console.warn("[status] WebSocket closed, reconnecting in 2s...");
        setTimeout(() => { void connect(); }, 2000);
      };

      ws.onerror = (err) => {
        console.error("[status] WebSocket error:", err);
      };
    };

    await connect();
  }

  /**
   * Check if RPC handlers are registered and responding.
   * Calls wakuext_joinedCommunities and checks for "does not exist" error
   * which indicates the wakuext namespace isn't registered yet.
   */
  async isRpcReady(): Promise<boolean> {
    try {
      const r = await this.callRpc("wakuext_joinedCommunities");
      if (r.error?.message?.includes("does not exist")) return false;
      return true;
    } catch {
      return false;
    }
  }

  // --- Helpers ---

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const r = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new StatusBackendError(`HTTP ${r.status}: ${text}`);
    }
    const json = await r.json() as Record<string, unknown>;
    // status-backend HTTP API errors are strings (e.g. "account does not exist")
    // JSON-RPC errors are objects with {code, message} — don't throw on those
    if (typeof json.error === "string" && json.error.length > 0) {
      throw new StatusBackendError(json.error);
    }
    return json;
  }
}
