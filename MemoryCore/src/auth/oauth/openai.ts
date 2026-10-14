import { createHash } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import {
  OAuthFailure,
  type LoginAttempt,
  type OAuthAuthAdapter,
  type OAuthCredential,
} from "./types.js";
export const OPENAI_RESOURCE = "https://api.openai.com/v1";
const ISSUER = "https://auth.openai.com";
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  PLAN_SCOPE,
];
type Json = Record<string, any>;
export type Http = typeof fetch;
/** Provider responses are never propagated verbatim: they can contain credentials or prompts. */
export async function responseJson(response: Response): Promise<Json> {
  try {
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
    return value as Json;
  } catch {
    throw new OAuthFailure("invalid_response");
  }
}
export function providerFailure(
  status: number,
  code?: string,
  requestId?: string,
): OAuthFailure {
  const known = new Set([
    "subscription_sharing_usage_limit_exceeded",
    "subscription_sharing_usage_unavailable",
    "subscription_sharing_user_not_eligible",
    "subscription_sharing_unsupported_capability",
    "subscription_sharing_route_not_supported",
    "subscription_sharing_invalid_user",
    "subscription_sharing_user_unavailable",
    "chatpass_v2_scope_not_authorized",
    "chatpass_v2_invalid_authorization_context",
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
    "invalid_client",
  ]);
  const safeCode = code && known.has(code) ? code : undefined;
  const safeId =
    requestId && /^[A-Za-z0-9_-]{1,128}$/.test(requestId)
      ? requestId
      : undefined;
  const failure = (kind: ConstructorParameters<typeof OAuthFailure>[0]) =>
    new OAuthFailure(kind, status, undefined, safeCode, safeId);
  if (status === 429 || code === "subscription_sharing_usage_limit_exceeded")
    return failure("quota_limited");
  if (
    code === "subscription_sharing_usage_unavailable" ||
    code === "subscription_sharing_user_unavailable"
  )
    return failure("unavailable");
  if (code === "invalid_client") return failure("configuration_error");
  if (
    status === 401 ||
    [
      "invalid_grant",
      "invalid_refresh_token",
      "token_expired",
      "refresh_token_expired",
      "refresh_token_invalidated",
      "refresh_token_reused",
      "subscription_sharing_invalid_user",
    ].includes(code ?? "")
  )
    return failure("login_required");
  if (
    status === 403 ||
    [
      "subscription_sharing_user_not_eligible",
      "subscription_sharing_route_not_supported",
      "chatpass_v2_scope_not_authorized",
      "chatpass_v2_invalid_authorization_context",
    ].includes(code ?? "")
  )
    return failure("policy_denied");
  if (status === 400 || code === "subscription_sharing_unsupported_capability")
    return failure("unsupported_capability");
  return failure("unavailable");
}
export class OpenAIAuthAdapter implements OAuthAuthAdapter {
  readonly id = "openai";
  readonly initialClientId = "dynamic_agent_client";
  readonly inferenceScopes = [PLAN_SCOPE, "resource.invoke"];
  private discovery?: Promise<Json>;
  constructor(private readonly http: Http = fetch) {}
  authorizationUrl(attempt: LoginAttempt, consent: boolean): string {
    const u = new URL(`${ISSUER}/api/accounts/authorize`);
    const params: Record<string, string> = {
      client_id: attempt.clientId,
      ext_agent_host_id: attempt.hostId,
      response_type: "code",
      redirect_uri: attempt.redirectUri,
      scope: SCOPES.join(" "),
      resource: OPENAI_RESOURCE,
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256")
        .update(attempt.verifier)
        .digest("base64url"),
    };
    if (attempt.clientId === "dynamic_agent_client")
      params.agent_name_hint = "AgentMemory";
    // Keep authorization URLs free of retained ID tokens so CLI output cannot leak a token.
    if (consent) params.prompt = "consent";
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }
  private async metadata(): Promise<Json> {
    this.discovery ??= (async () => {
      const res = await this.http(
        `${ISSUER}/.well-known/openid-configuration`,
        { signal: AbortSignal.timeout(15_000), redirect: "error" },
      );
      if (!res.ok) throw new OAuthFailure("unavailable");
      const d = await responseJson(res);
      if (d.issuer !== ISSUER) throw new OAuthFailure("invalid_response");
      for (const field of ["jwks_uri", "revocation_endpoint"]) {
        if (typeof d[field] !== "string" || new URL(d[field]).origin !== ISSUER)
          throw new OAuthFailure("invalid_response");
      }
      return d;
    })().catch((e) => {
      this.discovery = undefined;
      throw e;
    });
    return this.discovery;
  }
  private async validateId(
    token: string,
    clientId: string,
    nonce?: string,
  ): Promise<{ subject: string; email?: string }> {
    try {
      const meta = await this.metadata();
      const res = await this.http(meta.jwks_uri, {
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      if (!res.ok) throw 0;
      const jwks = await responseJson(res);
      const { payload } = await jwtVerify(
        token,
        createLocalJWKSet(jwks as JSONWebKeySet),
        {
          issuer: ISSUER,
          audience: clientId,
          algorithms: ["RS256"],
          requiredClaims: ["sub", "exp", "iat"],
        },
      );
      if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce))
        throw 0;
      return {
        subject: payload.sub,
        email: typeof payload.email === "string" ? payload.email : undefined,
      };
    } catch {
      throw new OAuthFailure("identity_mismatch");
    }
  }
  private async token(
    form: Record<string, string>,
    previous?: OAuthCredential,
    nonce?: string,
  ): Promise<OAuthCredential> {
    let response: Response;
    try {
      response = await this.http(TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...form, resource: OPENAI_RESOURCE }),
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
      });
    } catch {
      throw new OAuthFailure(previous ? "refresh_uncertain" : "unavailable");
    }
    const data = await responseJson(response);
    if (!response.ok) {
      if (previous && (response.status >= 500 || response.status === 429))
        throw new OAuthFailure(
          "unavailable",
          response.status,
          Date.now() + 30_000,
          "refresh_retryable",
        );
      if (
        data.error === "refresh_token_too_early" ||
        data.error === "refresh_not_allowed"
      ) {
        const retryAt = normalizeRefresh(data.earliest_refresh_at);
        throw new OAuthFailure(
          "unavailable",
          response.status,
          retryAt,
          "refresh_not_allowed",
        );
      }
      throw providerFailure(
        response.status,
        typeof data.error === "string" ? data.error : undefined,
      );
    }
    if (
      data.token_type?.toLowerCase() !== "bearer" ||
      typeof data.access_token !== "string" ||
      !data.access_token ||
      typeof data.refresh_token !== "string" ||
      !data.refresh_token ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 ||
      (data.scope !== undefined && typeof data.scope !== "string")
    )
      throw new OAuthFailure("invalid_response");
    const idToken = data.id_token ?? previous?.idToken;
    if (typeof idToken !== "string" || !idToken)
      throw new OAuthFailure("invalid_response");
    const identity = data.id_token
      ? await this.validateId(idToken, form.client_id, nonce)
      : { subject: previous!.subject, email: previous!.email };
    if (previous && identity.subject !== previous.subject)
      throw new OAuthFailure("identity_mismatch");
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      earliestRefreshAt: normalizeRefresh(data.earliest_refresh_at),
      scopes:
        typeof data.scope === "string"
          ? data.scope.split(/\s+/).filter(Boolean)
          : (previous?.scopes ?? []),
      ...identity,
    };
  }
  exchange(attempt: LoginAttempt, code: string, clientId: string) {
    return this.token(
      {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: attempt.verifier,
        redirect_uri: attempt.redirectUri,
      },
      undefined,
      attempt.nonce,
    );
  }
  refresh(clientId: string, credential: OAuthCredential) {
    return this.token(
      {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: credential.refreshToken,
      },
      credential,
    );
  }
  async revoke(clientId: string, credential: OAuthCredential): Promise<void> {
    const meta = await this.metadata();
    const res = await this.http(meta.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: credential.refreshToken,
        token_type_hint: "refresh_token",
        client_id: clientId,
      }),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    if (res.status !== 200) throw new OAuthFailure("unavailable");
  }
}
function normalizeRefresh(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  throw new OAuthFailure("invalid_response");
}
