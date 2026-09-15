// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";

const pg=new PGlite();
const first="00000000-0000-0000-0000-000000000001", second="00000000-0000-0000-0000-000000000002";
beforeAll(async () => {
  await pg.exec(`create schema auth; create role authenticated; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to authenticated; grant execute on function auth.uid() to authenticated;
    insert into auth.users values('${first}'),('${second}');
    alter default privileges in schema public grant select,insert,update,delete on tables to authenticated;`);
  for(const file of readdirSync("supabase/migrations").sort()) await pg.exec(readFileSync(`supabase/migrations/${file}`,"utf8"));
},30_000);
afterAll(async () => pg.close());
async function account(id:string) { await pg.exec(`reset role; set role authenticated; set request.jwt.claim.sub='${id}';`); }
function snapshot(count:number, key="a".repeat(64)) {
  const row={source_key:"b".repeat(64),session_key:key,project_key:"c".repeat(64),started_at:"2026-09-01T00:00:00Z",ended_at:"2026-09-05T00:00:00Z",observed_at:"2026-09-05T00:00:00Z",model:"gpt-5.6-sol",origin:"Codex",input_tokens:count*100,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,total_tokens:count*100,token_event_count:count,estimate_microusd:count*400,aggregation_version:5};
  const turns=Array.from({length:count},(_,i) => ({turn_ordinal:i+1,occurred_at:new Date(Date.UTC(2026,8,1,0,i)).toISOString(),model:row.model,input_tokens:100,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,total_tokens:100,estimate_microusd:400,service_tier:"default",reasoning_effort:"high"}));
  return {row,turns};
}
async function upload(value:ReturnType<typeof snapshot>) { return pg.query<{accepted:boolean}>("select public.sync_usage_session_v3($1::jsonb,$2::jsonb) as accepted",[JSON.stringify(value.row),JSON.stringify(value.turns)]); }
it("atomic upserts are idempotent and stale device cannot prune newer turns",async () => {
  await account(first);
  expect((await upload(snapshot(120))).rows[0].accepted).toBe(true);
  expect((await upload(snapshot(120))).rows[0].accepted).toBe(true);
  expect((await upload(snapshot(80))).rows[0].accepted).toBe(false);
  expect((await pg.query<{n:number}>("select count(*)::int n from usage_turns")).rows[0].n).toBe(120);
  await expect(pg.query("select prune_usage_turns_v2('[]'::jsonb)")).rejects.toThrow("permission denied");
});
it("two source aliases of a session do not create two cloud totals",async () => {
  await account(first); const other=snapshot(121); other.row.source_key="d".repeat(64);
  await upload(other);
  expect((await pg.query<{n:number}>("select count(*)::int n from usage_sessions")).rows[0].n).toBe(1);
  expect((await pg.query<{n:number}>("select count(*)::int n from usage_turns")).rows[0].n).toBe(121);
});
it("invalid replacement rolls back and RLS isolates users",async () => {
  await account(first); const bad=snapshot(122); bad.turns[121].service_tier="invalid";
  await expect(upload(bad)).rejects.toThrow();
  expect((await pg.query<{n:number}>("select count(*)::int n from usage_turns")).rows[0].n).toBe(121);
  await account(second);
  expect((await pg.query("select * from usage_sessions")).rows).toEqual([]);
  expect((await pg.query<{data:unknown}>("select get_usage_session_v3($1,$2) data",["b".repeat(64),"a".repeat(64)])).rows[0].data).toBeNull();
  await upload(snapshot(2));
  expect((await pg.query<{n:number}>("select count(*)::int n from usage_turns")).rows[0].n).toBe(2);
});
it("cloud deletion pauses retries on every device but not other users",async () => {
  await account(first); await pg.query("select delete_cloud_usage_v3()");
  expect((await pg.query("select * from usage_sessions")).rows).toEqual([]);
  await expect(upload(snapshot(120))).rejects.toThrow("paused");
  await account(second);
  expect((await pg.query<{n:number}>("select count(*)::int n from usage_turns")).rows[0].n).toBe(2);
  await account(first); await pg.query("select resume_cloud_usage_v3()");
  expect((await upload(snapshot(1))).rows[0].accepted).toBe(true);
});
