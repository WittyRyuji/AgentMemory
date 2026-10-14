import {
  OAuthFailure,
  type OAuthAuthAdapter,
  type OAuthInferenceAdapter,
} from "./types.js";
import { OpenAIAuthAdapter } from "./openai.js";
import { OpenAIResponsesAdapter } from "./responses.js";
/** Code-level allowlist: adding an OAuth login never grants inference capability by itself. */
export class OAuthProviderRegistry {
  private auth = new Map<string, OAuthAuthAdapter>();
  private inference = new Map<string, OAuthInferenceAdapter>();
  registerAuth(adapter: OAuthAuthAdapter): this {
    if (this.auth.has(adapter.id))
      throw new OAuthFailure("configuration_error");
    this.auth.set(adapter.id, adapter);
    return this;
  }
  registerInference(id: string, adapter: OAuthInferenceAdapter): this {
    if (!this.auth.has(adapter.authProvider) || this.inference.has(id))
      throw new OAuthFailure("configuration_error");
    this.inference.set(id, adapter);
    return this;
  }
  resolve(id: string) {
    const inference = this.inference.get(id);
    if (!inference) throw new OAuthFailure("unsupported_capability");
    return { auth: this.auth.get(inference.authProvider)!, inference };
  }
}
export const oauthProviders = new OAuthProviderRegistry()
  .registerAuth(new OpenAIAuthAdapter())
  .registerInference("openai-responses", new OpenAIResponsesAdapter());
