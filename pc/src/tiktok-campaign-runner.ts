import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { TikTokCampaign, manifestDigest, validateCampaign, type CampaignManifest, type CampaignTransport } from "./tiktok-campaign.js";
import { AutojsService } from "./service/autojs.service.js";
import { NodeServerService } from "./service/node-server.service.js";
import { campaignHttpTransport } from "./tiktok-campaign-http.js";

/**
 * Reuse the authenticated native async task channel without another privilege.
 * @returns Transport bound to the existing PC service instances.
 */
export function campaignTransport(): CampaignTransport {
  return {
    dispatch: (params, clientId) => AutojsService.getInstance().dispatchTask("tiktok.post", params, 420, clientId),
    inspect: async taskId => {
      const task = await NodeServerService.getInstance().getTask(taskId);
      let result: unknown;
      try { result = task.resultDataJson ? JSON.parse(task.resultDataJson) : undefined; } catch { result = undefined; }
      return { status: task.status, clientId: task.clientId, scriptId: task.scriptId, createTimeUtc: task.createTimeUtc, result };
    },
  };
}

/**
 * Start an opt-in worker in the existing PC process; approval remains required.
 * @param env Private campaign enablement flag and directory.
 * @returns Function that stops this worker's scheduling timer.
 */
export function startCampaignWorker(env: NodeJS.ProcessEnv = process.env): () => void {
  if (env.TIKTOK_CAMPAIGN_ENABLED !== "true" || !env.TIKTOK_CAMPAIGN_DIRECTORY) return () => {};
  let busy = false;
  const directory = path.resolve(env.TIKTOK_CAMPAIGN_DIRECTORY);
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const campaign = await TikTokCampaign.open(directory, campaignTransport());
      const state = await campaign.tick();
      if (!["NOT_DUE", "COMPLETE", "HOLD_EXISTING_ATTEMPT"].includes(state)) console.log(`[TIKTOK-CAMPAIGN] ${state}`);
    } catch { console.error("[TIKTOK-CAMPAIGN] Held; inspect private approval, schedule and ledger"); }
    finally { busy = false; }
  }, 15000);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Run a local operator command; task commands reuse the existing PC process over loopback HTTP.
 * @param args Command, private campaign directory and reviewed operation arguments.
 * @param env Existing PC API port and token; no new broker session is initialized.
 * @param output Safe operator status output.
 * @param fetchImpl Injectable HTTP boundary for offline regression checks.
 * @returns Completion of one bounded operator command.
 */
export async function runCampaignCommand(args: string[], env: NodeJS.ProcessEnv = process.env, output: (value: string) => void = console.log, fetchImpl: typeof fetch = globalThis.fetch): Promise<void> {
  const [command, directory, ...values] = args;
  if (!directory) throw new Error("Usage: campaign <review|approve|tick|observed-first|inspect|status|recover|accept-public|reschedule|resume-precommit|continue-precommit-ambiguity> <private-directory> [...]");
  if (command === "review") {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")) as CampaignManifest;
    validateCampaign(manifest);
    output(JSON.stringify({ campaignId: manifest.campaignId, manifestSha256: manifestDigest(manifest), count: manifest.creatives.length })); return;
  }
  const taskCommand = ["tick", "observed-first", "inspect", "status", "recover", "resume-precommit", "continue-precommit-ambiguity"].includes(command);
  let transport: CampaignTransport = {
    dispatch: async () => { throw new Error("Filesystem-only operator commands cannot dispatch"); },
    inspect: async () => { throw new Error("Filesystem-only operator commands cannot inspect tasks"); },
  };
  if (taskCommand) {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")) as CampaignManifest;
    validateCampaign(manifest);
    transport = campaignHttpTransport(manifest.deviceClientId, env, fetchImpl);
  }
  const campaign = await TikTokCampaign.open(path.resolve(directory), transport);
  if (command === "approve") await campaign.approve(values[0], values[1]);
  else if (command === "tick" || command === "observed-first") output(await campaign.tick(new Date(), command === "observed-first"));
  else if (command === "resume-precommit") output(await campaign.resumeKnownPrecommit({ publicationId: values[0], statusTaskId: values[1], operatorActionId: values[2], reviewer: values[3], authorizationEvidenceSha256: values[4], originalHoldSnapshotFile: values[5], originalHoldSnapshotSha256: values[6] }));
  else if (command === "continue-precommit-ambiguity") output(await campaign.continueKnownPrecommitAmbiguity({ publicationId: values[0], statusTaskId: values[1], operatorActionId: values[2], reviewer: values[3], authorizationEvidenceSha256: values[4], originalHoldSnapshotFile: values[5], originalHoldSnapshotSha256: values[6], previousResumeSnapshotFile: values[7], previousResumeChainSha256: values[8] }));
  else if (command === "inspect") output(await campaign.inspect(values[0]));
  else if (command === "status" || command === "recover") output(await campaign.recover(values[0], command));
  else if (command === "accept-public") await campaign.acceptPublic(values[0], values[1], values[2], values[3]);
  else if (command === "reschedule") await campaign.reschedule(values[0], values[1]);
  else throw new Error("Unknown campaign command");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dotenv = await import("dotenv"); dotenv.config();
  await runCampaignCommand(process.argv.slice(2)).catch(() => { console.error("Campaign command held; inspect the private record and use the original publicationId"); process.exitCode = 1; });
}
