import { randomBytes } from "node:crypto";
import {
  OAuthFailure,
  type LoginAttempt,
  type OAuthAuthAdapter,
} from "./types.js";
import { PostgresOAuthVault, type LockedConnection } from "./vault.js";
export interface OAuthVault {
  withLock<T>(
    provider: string,
    label: string,
    fn: (connection: LockedConnection) => Promise<T>,
  ): Promise<T>;
}
/** Only trusted, operator-side commands can create/replace a connection. No gateway login route. */
export class OAuthService {
  constructor(
    readonly vault: OAuthVault,
    readonly auth: OAuthAuthAdapter,
    readonly label: string,
  ) {}
  async begin(redirectUri: string, consent = false): Promise<string> {
    const uri = new URL(redirectUri);
    if (
      uri.protocol !== "http:" ||
      uri.hostname !== "127.0.0.1" ||
      uri.pathname !== "/auth/callback" ||
      uri.search ||
      uri.hash ||
      uri.username ||
      uri.password
    )
      throw new OAuthFailure("configuration_error");
    return this.vault.withLock(this.auth.id, this.label, async (slot) => {
      const record = (await slot.read()) ?? PostgresOAuthVault.freshRecord();
      await slot.write(record); // Persist host identity before exposing the authorization URL.
      const attempt: LoginAttempt = {
        state: random(),
        nonce: random(),
        verifier: random(),
        redirectUri,
        hostId: record.hostId,
        clientId: record.clientId ?? this.auth.initialClientId,
        subject: record.subject,
        expiresAt: Date.now() + 10 * 60_000,
      };
      await slot.pending(attempt);
      return this.auth.authorizationUrl(attempt, consent);
    });
  }
  async callback(url: string): Promise<void> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new OAuthFailure("invalid_callback");
    }
    return this.vault.withLock(this.auth.id, this.label, async (slot) => {
      for (const key of ["state", "code", "client_id", "error"])
        if (u.searchParams.getAll(key).length > 1)
          throw new OAuthFailure("invalid_callback");
      const attempt = await slot.consume(u.searchParams.get("state") ?? "");
      if (
        `${u.origin}${u.pathname}` !== attempt.redirectUri ||
        u.hash ||
        u.username ||
        u.password
      )
        throw new OAuthFailure("invalid_callback");
      if (u.searchParams.has("error"))
        throw new OAuthFailure("consent_required");
      const code = u.searchParams.get("code");
      const clientId =
        u.searchParams.get("client_id") ??
        (attempt.clientId !== this.auth.initialClientId
          ? attempt.clientId
          : undefined);
      if (
        !code ||
        !clientId ||
        clientId === this.auth.initialClientId ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(clientId)
      )
        throw new OAuthFailure("invalid_callback");
      if (
        attempt.clientId !== this.auth.initialClientId &&
        clientId !== attempt.clientId
      )
        throw new OAuthFailure("identity_mismatch");
      // Remember the registration before exchanging a one-shot code. If exchange fails,
      // reauthorization must use this issued ID, not create another dynamic client.
      // No credential becomes active until the returned identity is validated below.
      if (attempt.clientId === this.auth.initialClientId)
        await slot.write({
          hostId: attempt.hostId,
          clientId,
          status: "signed_out",
        });
      const credential = await this.auth.exchange(attempt, code, clientId);
      if (attempt.subject && credential.subject !== attempt.subject)
        throw new OAuthFailure("identity_mismatch");
      const record = {
        hostId: attempt.hostId,
        clientId,
        subject: credential.subject,
        credential,
        status: this.auth.inferenceScopes.every((scope) =>
          credential.scopes.includes(scope),
        )
          ? ("ready" as const)
          : ("consent_required" as const),
      };
      await slot.write(record);
      if (record.status !== "ready") throw new OAuthFailure("consent_required");
    });
  }
  async accessToken(): Promise<string> {
    return this.vault.withLock(this.auth.id, this.label, async (slot) => {
      const record = await slot.read();
      if (
        !record?.credential ||
        !record.clientId ||
        record.status === "signed_out" ||
        record.status === "login_required"
      )
        throw new OAuthFailure("login_required");
      if (record.status === "refreshing")
        throw new OAuthFailure("refresh_uncertain");
      if (
        record.status === "consent_required" ||
        !this.auth.inferenceScopes.every((scope) =>
          record.credential!.scopes.includes(scope),
        )
      )
        throw new OAuthFailure("consent_required");
      if (
        record.inferenceError &&
        (!record.inferenceRetryAt || record.inferenceRetryAt > Date.now())
      )
        throw new OAuthFailure(
          record.inferenceError,
          undefined,
          record.inferenceRetryAt,
        );
      const credential = record.credential;
      if (
        credential.expiresAt > Date.now() + 60_000 ||
        (credential.earliestRefreshAt &&
          Date.now() < credential.earliestRefreshAt &&
          credential.expiresAt > Date.now() + 5_000)
      )
        return credential.accessToken;
      if ((record.retryAt ?? credential.earliestRefreshAt ?? 0) > Date.now())
        throw new OAuthFailure(
          "unavailable",
          undefined,
          record.retryAt ?? credential.earliestRefreshAt,
        );
      // Intent is durable before the rotating refresh token is sent. A crash never replays it.
      await slot.write({ ...record, status: "refreshing" });
      try {
        const next = await this.auth.refresh(record.clientId, credential);
        if (next.subject !== record.subject)
          throw new OAuthFailure("identity_mismatch");
        const status = this.auth.inferenceScopes.every((scope) =>
          next.scopes.includes(scope),
        )
          ? ("ready" as const)
          : ("consent_required" as const);
        await slot.write({
          ...record,
          credential: next,
          status,
          retryAt: undefined,
          lastError: undefined,
        });
        if (status !== "ready") throw new OAuthFailure("consent_required");
        return next.accessToken;
      } catch (error) {
        const e =
          error instanceof OAuthFailure
            ? error
            : new OAuthFailure("refresh_uncertain");
        if (e.code === "consent_required") throw e;
        if (
          ["refresh_not_allowed", "refresh_retryable"].includes(
            e.providerCode ?? "",
          ) &&
          e.retryAt
        ) {
          await slot.write({ ...record, status: "ready", retryAt: e.retryAt });
          throw e;
        }
        // Even a malformed success may already have rotated the refresh token.
        await slot.write({
          ...record,
          credential: e.code === "login_required" ? undefined : credential,
          status: e.code === "login_required" ? "login_required" : "refreshing",
          lastError: e.code,
        });
        throw e;
      }
    });
  }
  /** Persist bounded admission backoff so another worker does not immediately retry. */
  async noteInferenceFailure(error: OAuthFailure): Promise<void> {
    if (!["quota_limited", "policy_denied", "unavailable"].includes(error.code))
      return;
    await this.vault.withLock(this.auth.id, this.label, async (slot) => {
      const record = await slot.read();
      if (!record?.credential || record.status !== "ready") return;
      const inferenceError = error.code as
        "quota_limited" | "policy_denied" | "unavailable";
      await slot.write({
        ...record,
        inferenceError,
        inferenceRetryAt:
          inferenceError === "policy_denied"
            ? undefined
            : Date.now() +
              (inferenceError === "quota_limited" ? 60_000 : 30_000),
      });
    });
  }
  async status() {
    return this.vault.withLock(this.auth.id, this.label, async (slot) => {
      const r = await slot.read();
      return {
        provider: this.auth.id,
        label: this.label,
        status: r?.status ?? "signed_out",
        subject: r?.subject,
        email: r?.credential?.email,
        expiresAt: r?.credential?.expiresAt,
        inferenceError: r?.inferenceError,
        retryAt: r?.inferenceRetryAt,
      };
    });
  }
  async logout(): Promise<{ revoked: boolean }> {
    return this.vault.withLock(this.auth.id, this.label, async (slot) => {
      const r = await slot.read();
      if (!r) return { revoked: true };
      // Keep stable registration and host mapping. Tokens are always cleared locally.
      let revoked = !r.credential;
      if (r.credential && r.clientId) {
        try {
          await this.auth.revoke(r.clientId, r.credential);
          revoked = true;
        } catch {
          revoked = false;
        }
      }
      await slot.write({
        hostId: r.hostId,
        clientId: r.clientId,
        subject: r.subject,
        status: "signed_out",
      });
      await slot.clearPending();
      return { revoked };
    });
  }
}
function random() {
  return randomBytes(32).toString("base64url");
}
