/** Authentication and inference are separate capabilities. An arbitrary OAuth grant is not an LLM provider. */
export interface OAuthCredential {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  earliestRefreshAt?: number;
  scopes: string[];
  subject: string;
  email?: string;
}
export interface LoginAttempt {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  hostId: string;
  subject?: string;
  expiresAt: number;
}
export interface OAuthAuthAdapter {
  readonly id: string;
  readonly initialClientId: string;
  readonly inferenceScopes: readonly string[];
  authorizationUrl(attempt: LoginAttempt, consent: boolean): string;
  exchange(
    attempt: LoginAttempt,
    code: string,
    clientId: string,
  ): Promise<OAuthCredential>;
  refresh(
    clientId: string,
    credential: OAuthCredential,
  ): Promise<OAuthCredential>;
  revoke(clientId: string, credential: OAuthCredential): Promise<void>;
}
export interface InferenceRequest {
  model: string;
  instructions?: string;
  input: Record<string, unknown>[];
  tools?: Record<string, unknown>[];
  signal: AbortSignal;
}
export interface InferenceResult {
  output: Record<string, unknown>[];
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}
export interface OAuthInferenceAdapter {
  readonly authProvider: string;
  complete(
    accessToken: string,
    request: InferenceRequest,
  ): Promise<InferenceResult>;
  models(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<Array<{ slug: string; displayName: string }>>;
}
export type OAuthErrorCode =
  | "login_required"
  | "consent_required"
  | "invalid_callback"
  | "identity_mismatch"
  | "invalid_response"
  | "refresh_uncertain"
  | "quota_limited"
  | "policy_denied"
  | "unavailable"
  | "unsupported_capability"
  | "incomplete_stream"
  | "aborted"
  | "storage_error"
  | "configuration_error"
  | "tool_error";
const MESSAGES: Record<OAuthErrorCode, string> = {
  login_required:
    "OAuth sign-in is required; run the owner OAuth login command.",
  consent_required:
    "ChatGPT plan permission is missing; explicitly enable plan use and sign in again.",
  invalid_callback:
    "OAuth callback was invalid, expired or already used; start sign-in again.",
  identity_mismatch: "OAuth identity did not match the selected registration.",
  invalid_response:
    "Provider returned an invalid response; no credentials or partial output were accepted.",
  refresh_uncertain:
    "Refresh outcome is uncertain; sign in again before retrying. The old rotating token will not be reused.",
  quota_limited:
    "ChatGPT plan/app usage limit reached; review https://chatgpt.com/#settings/Usage and retry later.",
  policy_denied:
    "Provider policy or account eligibility prevents this request; verify the selected account and integration.",
  unavailable:
    "OAuth provider is temporarily unavailable; retry later. No alternate billing path was used.",
  unsupported_capability:
    "This request uses a capability unsupported by the OAuth provider.",
  incomplete_stream:
    "Inference did not complete successfully; partial output was discarded.",
  aborted: "OAuth inference was cancelled or timed out.",
  storage_error:
    "OAuth credential storage failed; check database access and encryption-key configuration.",
  configuration_error:
    "Independent OAuth is not configured correctly; see OAUTH.md.",
  tool_error:
    "OAuth tool invocation was invalid or exceeded its execution limit.",
};
/** Only this sanitized error crosses the runner/log/client boundary. Never attach raw errors or responses. */
export class OAuthFailure extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    readonly status?: number,
    readonly retryAt?: number,
    readonly providerCode?: string,
    readonly requestId?: string,
  ) {
    super(MESSAGES[code]);
    this.name = "OAuthFailure";
  }
}
export function safeFailure(error: unknown): OAuthFailure {
  return error instanceof OAuthFailure
    ? error
    : new OAuthFailure("unavailable");
}
