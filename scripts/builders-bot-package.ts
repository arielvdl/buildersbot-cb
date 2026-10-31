import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { parse as parseYaml } from "yaml";
import { decideUpdateFeed } from "../src/main/update-feed-policy";

/** The names that electron-builder.yml gives to every package: the app name, its folders and its id. */
interface BuilderIdentity {
  readonly productName: string;
  readonly appId: string;
}

/** Reads `productName` and `appId` from electron-builder.yml, so a check follows a rename. */
export function readBuilderIdentity(): BuilderIdentity {
  const config = parseYaml(readFileSync(resolve(import.meta.dirname, "../electron-builder.yml"), "utf8"));
  if (!isDynamicRecord(config) || !isString(config.productName) || !isString(config.appId)) {
    throw new Error("electron-builder.yml has no productName or appId.");
  }
  return { productName: config.productName, appId: config.appId };
}

/**
 * Stops a package check when the packaged app-update.yml names a feed that the update feed policy
 * refuses (`src/main/update-feed-policy.ts`). No feed passes yet, so a package must have no
 * app-update.yml. `metadata` is null when the package has none.
 */
export function assertAllowedUpdateFeed(metadata: string | null): void {
  if (metadata === null) return;
  const decision = decideUpdateFeed(metadata);
  if (!decision.allowed) {
    throw new Error(`The packaged app-update.yml names an update feed that is not allowed (${decision.reason}).`);
  }
}
