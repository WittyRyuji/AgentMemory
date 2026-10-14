import { createHash } from 'node:crypto';
import type { PostgresStorage } from './postgres-storage.js';

export const PROXY_TURN_SEQ_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS proxy_turn_sequences (
  k TEXT PRIMARY KEY,
  state JSONB NOT NULL DEFAULT '{}',
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS proxy_turn_sequences_expiry ON proxy_turn_sequences(expires_at);
CREATE OR REPLACE FUNCTION proxy_allocate_turn_seq(key_text TEXT, lane TEXT, local_seq BIGINT, ttl_seconds BIGINT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  current_state JSONB; expiry BIGINT; seq BIGINT;
  now_second BIGINT := floor(extract(epoch FROM clock_timestamp()));
BEGIN
  INSERT INTO proxy_turn_sequences(k,expires_at) VALUES(key_text,now_second+ttl_seconds) ON CONFLICT DO NOTHING;
  SELECT state,expires_at INTO current_state,expiry FROM proxy_turn_sequences WHERE k=key_text FOR UPDATE;
  now_second := floor(extract(epoch FROM clock_timestamp()));
  IF expiry<=now_second THEN current_state := '{}'; END IF;
  IF current_state->>('k:'||lane)=local_seq::text AND current_state ? ('s:'||lane) THEN
    seq := (current_state->>('s:'||lane))::bigint;
  ELSE
    seq := GREATEST(COALESCE((current_state->>'seq')::bigint,0)+1,local_seq);
    current_state := current_state || jsonb_build_object('seq',seq,'k:'||lane,local_seq::text,'s:'||lane,seq);
  END IF;
  UPDATE proxy_turn_sequences SET state=current_state,expires_at=now_second+ttl_seconds WHERE k=key_text;
  RETURN seq;
END $$;`;

export async function allocatePostgresTurnSeq(storage: PostgresStorage, sessionKey: string, lane: string, localSeq: number, ttlSeconds: number): Promise<number> {
  const key = createHash('sha256').update(sessionKey).digest('hex');
  const result = await storage.sql.query('SELECT proxy_allocate_turn_seq($1,$2,$3,$4) AS seq', [key, lane, localSeq, ttlSeconds]);
  return Number(result.rows[0]!.seq);
}
