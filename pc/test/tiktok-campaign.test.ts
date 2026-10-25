import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { TikTokCampaign, manifestDigest, validateCampaign, type CampaignManifest, type CampaignTransport } from "../src/tiktok-campaign.js";

/** Private synthetic fixture never contacts a phone or provider. */
async function fixture(t: any, failDelivery = false) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "tiktok-campaign-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const videoPaths = [0,1,2].map(i=>path.join(dir, `synthetic-${i}.mp4`));
  for (let i=0;i<3;i++) await fs.writeFile(videoPaths[i], `synthetic-video-${i}`);
  const manifest: CampaignManifest = { schemaVersion: 1, campaignId: "synthetic-pilot", timezone: "Asia/Shanghai", expectedHandle: "synthetic_shop", deviceClientId: "synthetic-device",
    creatives: [0, 1, 2].map((i) => { const sha256=createHash("sha256").update(`synthetic-video-${i}`).digest("hex"); return ({ publicationId: randomUUID(), sku: `SHUSHA-L${1300+i}`, videoPath:videoPaths[i],
      devicePath: `/sdcard/Download/pilot-${i}-${sha256.slice(0,16)}.mp4`, sha256,
      title: `Reviewed style ${i}`, caption: `Request a quote for style L${1300+i}.`,
      landingUrl: "https://shop.this-time.com/wholesale?utm_source=tiktok&utm_campaign=synthetic-pilot",
      sourceVerifiedAt: "2026-10-25T12:00:00.000Z", sourceEvidenceSha256: "a".repeat(64),
      scheduledAt: `2026-10-${26+i*2}T13:00:00.000Z`, postSettings: { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND" } }); }) };
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  const calls: any[] = []; let result: any;
  const transport: CampaignTransport = { dispatch: async (params, clientId) => { calls.push({params,clientId}); if(failDelivery) throw new Error("Lost response"); return {taskId:"synthetic-task"}; }, inspect: async () => ({clientId:"synthetic-device",scriptId:"tiktok.post",createTimeUtc:Date.parse("2026-10-26T13:00Z"),...result}) };
  return { dir, manifest, calls, campaign: await TikTokCampaign.open(dir, transport), setResult: (r: unknown) => result = r };
}

test("no approval or modified caption can dispatch", async t => {
  const f = await fixture(t); const due = new Date(f.manifest.creatives[0].scheduledAt);
  await assert.rejects(f.campaign.tick(due, true), /approval/);
  await f.campaign.approve(manifestDigest(f.manifest), "merchant", new Date("2026-10-25T13:00Z"));
  f.manifest.creatives[0].caption = "Changed after review";
  await fs.writeFile(path.join(f.dir,"manifest.json"),JSON.stringify(f.manifest));
  await assert.rejects(f.campaign.tick(due,true), /approval/); assert.equal(f.calls.length,0);
});

test("changed video and unattended first post are held", async t => {
  const f = await fixture(t); await f.campaign.approve(manifestDigest(f.manifest),"merchant",new Date("2026-10-25T13:00Z"));
  const due = new Date(f.manifest.creatives[0].scheduledAt);
  await assert.rejects(f.campaign.tick(due), /observing/);
  await fs.writeFile(f.manifest.creatives[0].videoPath,"replaced");
  await assert.rejects(f.campaign.tick(due,true), /changed/); assert.equal(f.calls.length,0);
});

test("uncertain delivery persists the original ID and cannot be republished", async t => {
  const f = await fixture(t,true); await f.campaign.approve(manifestDigest(f.manifest),"merchant",new Date("2026-10-25T13:00Z"));
  const due = new Date(f.manifest.creatives[0].scheduledAt);
  assert.equal(await f.campaign.tick(due,true),"HOLD");
  assert.equal(await f.campaign.tick(due,true),"HOLD_EXISTING_ATTEMPT");
  assert.equal(f.calls.length,1); assert.equal(f.calls[0].params.publicationId,f.manifest.creatives[0].publicationId);
  assert.equal(f.calls[0].params.media.expectedSha256,f.manifest.creatives[0].sha256);
  assert.deepEqual(f.calls[0].params.content.titles,[]);
});

test("missed slots never catch up or skip ahead", async t => {
  const f=await fixture(t); await f.campaign.approve(manifestDigest(f.manifest),"merchant",new Date("2026-10-25T13:00Z"));
  assert.equal(await f.campaign.tick(new Date("2026-10-26T13:01Z"),true),"MISSED");
  assert.equal(await f.campaign.tick(new Date("2026-10-28T13:00Z")),"HOLD_EXISTING_ATTEMPT"); assert.equal(f.calls.length,0);
});

test("technical link evidence still requires independent public review before second dispatch", async t => {
  const f=await fixture(t); await f.campaign.approve(manifestDigest(f.manifest),"merchant",new Date("2026-10-25T13:00Z"));
  await f.campaign.tick(new Date(f.manifest.creatives[0].scheduledAt),true);
  const id=f.manifest.creatives[0].publicationId; const url="https://www.tiktok.com/@synthetic_shop/video/123456";
  await assert.rejects(f.campaign.acceptPublic(id,url,"observer","b".repeat(64)),/Verified original/);
  f.setResult({status:"SUCCESS",result:{contractVersion:2,action:"publish",publicationId:id,phase:"LINK_CONFIRMED",outcome:"SUCCESS",success:true,published:true,
    post:{canonicalUrl:url,postId:"123456",verified:true},postSettings:{audience:"PUBLIC",commercialDisclosure:"YOUR_BRAND"},
    postSettingsEvidence:{audience:"PUBLIC",commercialDisclosure:"YOUR_BRAND",verified:true,verifiedAt:Date.parse("2026-10-26T13:00Z")},
    creativeEvidence:{mediaSha256:f.manifest.creatives[0].sha256,captionSha256:createHash("sha256").update(JSON.stringify({title:f.manifest.creatives[0].title,details:f.manifest.creatives[0].caption})).digest("hex")}}});
  assert.equal(await f.campaign.inspect(id,new Date("2026-10-26T13:01Z")),"REVIEW_REQUIRED");
  assert.equal(await f.campaign.tick(new Date("2026-10-28T13:00Z")),"HOLD_EXISTING_ATTEMPT");
  await f.campaign.acceptPublic(id,url,"observer","b".repeat(64),new Date("2026-10-26T13:05Z"));
  assert.equal(await f.campaign.tick(new Date("2026-10-28T13:00Z")),"ACCEPTED"); assert.equal(f.calls.length,2);
});

test("wrong account result or missing disclosure stays held; recovery uses same ID", async t => {
  const f=await fixture(t); await f.campaign.approve(manifestDigest(f.manifest),"merchant",new Date("2026-10-25T13:00Z"));
  await f.campaign.tick(new Date(f.manifest.creatives[0].scheduledAt),true); const id=f.manifest.creatives[0].publicationId;
  f.setResult({status:"SUCCESS",result:{publicationId:id,phase:"LINK_CONFIRMED",post:{canonicalUrl:"https://www.tiktok.com/@other/video/123"}}});
  assert.equal(await f.campaign.inspect(id),"HOLD");
  await f.campaign.recover(id,"recover");
  assert.equal(f.calls.at(-1).params.action,"recover"); assert.equal(f.calls.at(-1).params.publicationId,id);
  await assert.rejects(f.campaign.recover(randomUUID(),"recover"),/original attempt/);
  await assert.rejects(f.campaign.recover(id,"publish" as any),/can only query/);
});

test("active lock is never removed or bypassed", async t => {
  const f=await fixture(t); await fs.writeFile(path.join(f.dir,"campaign.lock"),"other-owner");
  await assert.rejects(f.campaign.approve(manifestDigest(f.manifest),"merchant"),{code:"EEXIST"});
  assert.equal(await fs.readFile(path.join(f.dir,"campaign.lock"),"utf8"),"other-owner");
});

test("missed slots can only be explicitly replanned and reviewed, preserving IDs and journal", async t => {
  const f=await fixture(t); const old=structuredClone(f.manifest);
  await f.campaign.approve(manifestDigest(f.manifest),"merchant",new Date("2026-10-25T13:00Z"));
  await f.campaign.tick(new Date("2026-10-26T13:01Z"),true);
  await f.campaign.reschedule("2026-11-01T13:00:00.000Z","merchant",new Date("2026-10-27T12:00Z"));
  const changed=JSON.parse(await fs.readFile(path.join(f.dir,"manifest.json"),"utf8"));
  assert.deepEqual(changed.creatives.map((c:any)=>c.publicationId),old.creatives.map(c=>c.publicationId));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dir,"reschedule-journal.json"),"utf8"))[0].originalLedger[0].state,"MISSED");
  await assert.rejects(f.campaign.tick(new Date("2026-11-01T13:00Z"),true),/approval/);
  await f.campaign.approve(manifestDigest(changed),"merchant",new Date("2026-10-27T12:01Z"));
  assert.equal(await f.campaign.tick(new Date("2026-11-01T13:00Z"),true),"ACCEPTED");
});

test("mutating device/account after dispatch cannot redirect original-ID recovery", async t => {
  const f=await fixture(t); await f.campaign.approve(manifestDigest(f.manifest),"merchant",new Date("2026-10-25T13:00Z"));
  await f.campaign.tick(new Date(f.manifest.creatives[0].scheduledAt),true);
  f.manifest.deviceClientId="other-device"; await fs.writeFile(path.join(f.dir,"manifest.json"),JSON.stringify(f.manifest));
  await assert.rejects(f.campaign.recover(f.manifest.creatives[0].publicationId,"recover"),/Original approved/);
  assert.equal(f.calls.length,1);
});

test("canonical campaign validation preserves reviewed bytes and permits approval", async t => {
  const f = await fixture(t); const original = JSON.stringify(f.manifest); const digest = manifestDigest(f.manifest);
  validateCampaign(f.manifest);
  assert.equal(JSON.stringify(f.manifest), original); assert.equal(manifestDigest(f.manifest), digest);
  await f.campaign.approve(digest, "merchant", new Date("2026-10-25T13:00Z"));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dir, "approval.json"), "utf8")).manifestSha256, digest);
  assert.equal(f.calls.length, 0);
});

test("uppercase or whitespace publication UUIDs are rejected before approval", async t => {
  for (const id of ["6D0A0D9A-1122-4344-8556-778899AABBCC", " 6d0a0d9a-1122-4344-8556-778899aabbcc "]) {
    const f = await fixture(t); f.manifest.creatives[0].publicationId = id;
    await fs.writeFile(path.join(f.dir, "manifest.json"), JSON.stringify(f.manifest));
    await assert.rejects(f.campaign.approve(manifestDigest(f.manifest), "merchant"), /Canonical lowercase/);
    await assert.rejects(fs.access(path.join(f.dir, "approval.json")), { code: "ENOENT" });
    assert.equal(f.calls.length, 0);
  }
});

test("case-only UUID duplicates cannot become two reviewed publications", async t => {
  const f = await fixture(t);
  f.manifest.creatives[0].publicationId = "6d0a0d9a-1122-4344-8556-778899aabbcc";
  f.manifest.creatives[1].publicationId = f.manifest.creatives[0].publicationId.toUpperCase();
  await fs.writeFile(path.join(f.dir, "manifest.json"), JSON.stringify(f.manifest));
  await assert.rejects(f.campaign.approve(manifestDigest(f.manifest), "merchant"), /Canonical lowercase|Duplicate publication/);
  await assert.rejects(fs.access(path.join(f.dir, "approval.json")), { code: "ENOENT" });
  assert.equal(f.calls.length, 0);
});

test("copy requiring dispatch trimming is rejected before merchant approval", async t => {
  for (const mutate of [
    (manifest: CampaignManifest) => { manifest.creatives[0].title = " " + manifest.creatives[0].title; },
    (manifest: CampaignManifest) => { manifest.creatives[0].caption += "\n"; },
  ]) {
    const f = await fixture(t); mutate(f.manifest);
    await fs.writeFile(path.join(f.dir, "manifest.json"), JSON.stringify(f.manifest));
    await assert.rejects(f.campaign.approve(manifestDigest(f.manifest), "merchant"), /must already be trimmed/);
    await assert.rejects(fs.access(path.join(f.dir, "approval.json")), { code: "ENOENT" });
    assert.equal(f.calls.length, 0);
  }
});
