import { beforeAll, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { demoSessions } from "./mockData";
import { downloadPayload, fingerprint, localKey, queueSnapshots, remoteFingerprint, uploadPayload } from "./cloudSync";

beforeAll(() => Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true}));
const sample = () => {
  const session=structuredClone(demoSessions.find((s) => s.turns?.length)!);
  session.tokens=session.turns!.reduce((acc,turn) => {
    for (const key of Object.keys(acc) as Array<keyof typeof acc>) acc[key]+=turn.tokens[key]; return acc;
  },{inputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:0});
  session.tokenEventCount=session.turns!.length;
  return session;
};
it("keeps pending snapshots until acknowledgement and replaces them on append",() => {
  const item=sample(); let state=queueSnapshots({pending:{},acknowledged:{},lastSyncedAt:null},[item]);
  expect(Object.keys(state.pending)).toHaveLength(1);
  state=queueSnapshots(JSON.parse(JSON.stringify(state)),[item]);
  expect(Object.keys(state.pending)).toHaveLength(1);
  state.acknowledged[localKey(item)]=fingerprint(item);
  expect(queueSnapshots(state,[item]).pending).toEqual({});
  item.tokens.totalTokens++;
  expect(Object.keys(queueSnapshots(state,[item]).pending)).toHaveLength(1);
});
it("uses the same cloud keys across machines and excludes sensitive metadata",async () => {
  const item=sample(); item.sourceId="ssh-workstation";item.sourceName="SECRET_HOST";item.project="SECRET_PROJECT";item.origin="SECRET_ORIGIN";
  const first=await uploadPayload("user",item);
  const second=await uploadPayload("user",{...item,sourceId:"local",sourceName:"other"});
  expect(first.p_session.source_key).toBe(second.p_session.source_key);
  expect(first.p_session.session_key).toBe(second.p_session.session_key);
  const text=JSON.stringify(first);
  for (const forbidden of ["SECRET_HOST","SECRET_PROJECT","SECRET_ORIGIN",item.sessionId,"ssh-workstation","prompt","toolOutput"]) expect(text).not.toContain(forbidden);
  const result=downloadPayload({session:first.p_session,turns:first.p_turns});
  expect(result.session.tokens).toEqual(item.tokens);
});
it("does not upload summary-only or incomplete snapshots",async () => {
  const item=sample(); item.turns=undefined;
  await expect(uploadPayload("user",item)).rejects.toThrow("不完整");
});

it("changes the remote version for corrected breakdowns with unchanged totals and timestamps", async () => {
  const { p_session: row } = await uploadPayload("user", sample());
  const version = remoteFingerprint(row);
  const corrections = [
    { input_tokens: row.input_tokens - 1, output_tokens: row.output_tokens + 1 },
    { cached_input_tokens: row.cached_input_tokens + 1 },
    { cache_write_input_tokens: row.cache_write_input_tokens + 1 },
    { reasoning_output_tokens: row.reasoning_output_tokens + 1 },
    { model: "corrected-model" },
  ];
  for (const correction of corrections) {
    expect(remoteFingerprint({ ...row, ...correction })).not.toBe(version);
  }
  expect(remoteFingerprint({ ...row })).toBe(version);
});

it("uses the server revision for changes confined to turns", async () => {
  const { p_session: row } = await uploadPayload("user", sample());
  expect(remoteFingerprint({ ...row, sync_revision: "first" }))
    .not.toBe(remoteFingerprint({ ...row, sync_revision: "second" }));
});
