import { createHash } from 'node:crypto';
import type { RateLimitConfig } from '../types.js';
import type { PostgresStorage } from '../storage/postgres-storage.js';
import type { RateLimitDecision, RateLimitOverride } from './redis-store.js';

const GLOBAL_KEY = 'nottl/_system/rate-limit/defaults.json';
const OVERRIDE_PREFIX = 'nottl/_system/rate-limit/overrides/';
const dimension = (instanceId: string, modelId: string) => JSON.stringify([instanceId, modelId]);
export const rateLimitOverrideKey = (instanceId: string, modelId: string) =>
  `${OVERRIDE_PREFIX}${createHash('sha256').update(dimension(instanceId, modelId)).digest('hex')}.json`;
export const RATE_LIMIT_GLOBAL_KEY = GLOBAL_KEY;

/** One locked row per instance/model; DB time and per-second buckets match Redis. */
export const PROXY_RATE_LIMIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS proxy_rate_limit_windows (
  dimension TEXT PRIMARY KEY,
  buckets JSONB NOT NULL DEFAULT '{}',
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS proxy_rate_limit_windows_updated ON proxy_rate_limit_windows(updated_at);
CREATE OR REPLACE FUNCTION proxy_rate_limit_apply(
  dim TEXT, token_amount BIGINT, check_request BOOLEAN,
  default_tpm BIGINT, default_qpm BIGINT, global_key TEXT, override_key TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  now_second BIGINT := floor(extract(epoch FROM clock_timestamp()));
  window_data JSONB; fresh JSONB := '{}'; bucket JSONB; limits JSONB;
  entry RECORD; used_tokens BIGINT := 0; used_requests BIGINT := 0;
  limit_tpm BIGINT := default_tpm; limit_qpm BIGINT := default_qpm;
  reason TEXT := NULL; retry_after BIGINT := 0; released BIGINT := 0; deficit BIGINT;
BEGIN
  SELECT v::jsonb INTO limits FROM proxy_kv WHERE k=global_key;
  limit_tpm := COALESCE((limits->>'tpm')::bigint,limit_tpm);
  limit_qpm := COALESCE((limits->>'qpm')::bigint,limit_qpm);
  SELECT v::jsonb INTO limits FROM proxy_kv WHERE k=override_key;
  limit_tpm := COALESCE((limits->>'tpm')::bigint,limit_tpm);
  limit_qpm := COALESCE((limits->>'qpm')::bigint,limit_qpm);
  INSERT INTO proxy_rate_limit_windows(dimension,updated_at) VALUES(dim,now_second) ON CONFLICT DO NOTHING;
  SELECT buckets INTO window_data FROM proxy_rate_limit_windows WHERE dimension=dim FOR UPDATE;
  -- Take time after acquiring the lock, so queued requests use their actual window.
  now_second := floor(extract(epoch FROM clock_timestamp()));
  FOR entry IN SELECT key,value FROM jsonb_each(window_data) LOOP
    IF entry.key::bigint >= now_second-59 THEN
      fresh := fresh || jsonb_build_object(entry.key,entry.value);
      used_requests := used_requests + COALESCE((entry.value->>'requests')::bigint,0);
      used_tokens := used_tokens + COALESCE((entry.value->>'tokens')::bigint,0);
    END IF;
  END LOOP;
  IF check_request AND limit_qpm>0 AND used_requests+1>limit_qpm THEN reason := 'qpm';
  ELSIF check_request AND limit_tpm>0 AND used_tokens>=limit_tpm THEN reason := 'tpm'; END IF;
  IF reason IS NOT NULL THEN
    deficit := CASE WHEN reason='qpm' THEN used_requests+1-limit_qpm ELSE used_tokens-limit_tpm+1 END;
    retry_after := 60;
    FOR entry IN SELECT key,value FROM jsonb_each(fresh) ORDER BY key::bigint LOOP
      released := released + COALESCE((entry.value->>CASE WHEN reason='qpm' THEN 'requests' ELSE 'tokens' END)::bigint,0);
      IF released>=deficit THEN retry_after := GREATEST(1,entry.key::bigint+60-now_second); EXIT; END IF;
    END LOOP;
  ELSE
    bucket := COALESCE(fresh->now_second::text,'{}'::jsonb);
    IF check_request THEN
      used_requests := used_requests+1;
      bucket := bucket || jsonb_build_object('requests',COALESCE((bucket->>'requests')::bigint,0)+1);
    ELSE
      used_tokens := used_tokens+token_amount;
      bucket := bucket || jsonb_build_object('tokens',COALESCE((bucket->>'tokens')::bigint,0)+token_amount);
    END IF;
    fresh := fresh || jsonb_build_object(now_second::text,bucket);
  END IF;
  UPDATE proxy_rate_limit_windows SET buckets=fresh,updated_at=now_second WHERE dimension=dim;
  RETURN jsonb_build_object('allowed',reason IS NULL,'degraded',false,'reason',reason,
    'tpm',limit_tpm,'qpm',limit_qpm,'usedTokens',used_tokens,'usedRequests',used_requests,
    'remainingTokens',GREATEST(0,limit_tpm-used_tokens),'remainingRequests',GREATEST(0,limit_qpm-used_requests),
    'retryAfterSeconds',retry_after);
END $$;`;

export class PostgresRateLimitStore {
  constructor(private readonly storage: PostgresStorage, private readonly config: RateLimitConfig) {}
  isAvailable(): boolean { return true; }
  private async apply(instanceId: string, modelId: string, tokens: number, check: boolean): Promise<RateLimitDecision> {
    const result = await this.storage.sql.query('SELECT proxy_rate_limit_apply($1,$2,$3,$4,$5,$6,$7) AS decision',
      [dimension(instanceId, modelId), tokens, check, this.config.tpm, this.config.qpm, GLOBAL_KEY, rateLimitOverrideKey(instanceId, modelId)]);
    return result.rows[0]!.decision as unknown as RateLimitDecision;
  }
  async checkRequest(instanceId: string, modelId: string): Promise<RateLimitDecision> { return this.apply(instanceId, modelId, 0, true); }
  async recordInputTokens(instanceId: string, modelId: string, inputTokens: number): Promise<boolean> {
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) return false;
    await this.apply(instanceId, modelId, Math.floor(inputTokens), false); return true;
  }
  async getLimits(): Promise<{ tpm: number; qpm: number }> {
    return { ...this.config, ...await this.storage.getJSON<{ tpm?: number; qpm?: number }>(GLOBAL_KEY) };
  }
  async setLimits(limits: { tpm?: number; qpm?: number }): Promise<void> {
    await this.storage.sql.query(
      `INSERT INTO proxy_kv(k,v,bucket,updated_at) VALUES($1,$2,'nottl',$3)
       ON CONFLICT(k) DO UPDATE SET v=(proxy_kv.v::jsonb || EXCLUDED.v::jsonb)::text,updated_at=EXCLUDED.updated_at`,
      [GLOBAL_KEY, JSON.stringify(limits), Date.now()]);
  }
  async deleteLimits(): Promise<void> { await this.storage.del(GLOBAL_KEY); }
  async getOverride(instanceId: string, modelId: string): Promise<{ tpm: number; qpm: number } | null> {
    const row = await this.storage.getJSON<RateLimitOverride>(rateLimitOverrideKey(instanceId, modelId));
    return row ? { tpm: row.tpm, qpm: row.qpm } : null;
  }
  async setOverride(instanceId: string, modelId: string, limits: { tpm: number; qpm: number }): Promise<void> {
    await this.storage.putJSON(rateLimitOverrideKey(instanceId, modelId), { instanceId, modelId, ...limits });
  }
  async deleteOverride(instanceId: string, modelId: string): Promise<void> { await this.storage.del(rateLimitOverrideKey(instanceId, modelId)); }
  async listOverrides(): Promise<RateLimitOverride[]> {
    const names = await this.storage.listNames(OVERRIDE_PREFIX);
    const rows = await Promise.all(names.map(n => this.storage.getJSON<RateLimitOverride>(OVERRIDE_PREFIX+n)));
    return rows.filter((row): row is RateLimitOverride => !!row).sort((a,b) => a.instanceId.localeCompare(b.instanceId) || a.modelId.localeCompare(b.modelId));
  }
}
