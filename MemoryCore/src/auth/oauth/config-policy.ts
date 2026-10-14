import { OAuthFailure } from "./types.js";
/** Request-level seed overrides must not select a different stored owner registration. */
export function validateSeedOAuthOverride(
  provider: string | undefined,
  override: unknown,
): void {
  if (!override || typeof override !== "object" || Array.isArray(override))
    return;
  const llm = (override as Record<string, unknown>).llm;
  if (!llm || typeof llm !== "object" || Array.isArray(llm)) return;
  const fields = llm as Record<string, unknown>;
  if (
    Object.hasOwn(fields, "oauth") ||
    (provider === "oauth" &&
      Object.hasOwn(fields, "provider") &&
      fields.provider !== "oauth") ||
    (provider !== "oauth" && fields.provider === "oauth")
  )
    throw new OAuthFailure("configuration_error");
}
