import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { OAuthFailure } from "./types.js";
/** AES-256-GCM envelope. Associated data prevents swapping rows, providers or record kinds. */
export class CredentialCipher {
  #key: Buffer;
  constructor(encodedKey: string) {
    const key = Buffer.from(encodedKey, "base64");
    if (key.length !== 32 || key.toString("base64") !== encodedKey)
      throw new OAuthFailure("configuration_error");
    this.#key = key;
  }
  seal(value: unknown, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      encrypted.toString("base64url"),
    ].join(".");
  }
  open<T>(envelope: string, context: string): T {
    try {
      const [version, nonce, tag, encrypted, extra] = envelope.split(".");
      if (version !== "v1" || !nonce || !tag || !encrypted || extra)
        throw new Error();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#key,
        Buffer.from(nonce, "base64url"),
      );
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(encrypted, "base64url")),
          decipher.final(),
        ]).toString("utf8"),
      ) as T;
    } catch {
      throw new OAuthFailure("storage_error");
    }
  }
}
