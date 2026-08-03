#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalControlSurface } from "./local-control-surface.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ccByNdVideos = [
  ["/media/help/what-hawkspan-does.mp4", "what-hawkspan-does.mp4"],
  ["/media/help/hawkspan-profiles.mp4", "hawkspan-profiles.mp4"],
  ["/media/help/hawkspan-detailed-configuration.mp4", "hawkspan-detailed-configuration.mp4"],
  ["/media/help/hawkspan-connections.mp4", "hawkspan-connections.mp4"],
];
const allRightsReservedVideos = [
  ["/media/help/hawkspan-bottom-up-workflow.mp4", "hawkspan-bottom-up-workflow.mp4"],
];
const videos = [...ccByNdVideos, ...allRightsReservedVideos];

const notice = fs.readFileSync(path.join(repository, "NOTICE"), "utf8");
const mediaReadme = fs.readFileSync(
  path.join(repository, "static", "media", "help", "README.md"),
  "utf8",
);
for (const document of [notice, mediaReadme]) {
  assert.match(document, /Creative Commons Attribution-NoDerivatives 4\.0 International/);
  assert.match(document, /CC BY-ND 4\.0/);
  const ccSection = document.match(/Creative Commons Attribution-NoDerivatives[\s\S]*?(?:All Rights Reserved|## Video 5)/)?.[0];
  const arrSection = document.match(/(?:All Rights Reserved|## Video 5)[\s\S]*/)?.[0];
  for (const [, fileName] of ccByNdVideos) {
    assert.ok(ccSection?.includes(fileName), `${fileName} must remain mapped to CC BY-ND 4.0`);
    assert.equal(arrSection?.includes(fileName), false, `${fileName} must not be mapped to All Rights Reserved`);
  }
  for (const [, fileName] of allRightsReservedVideos) {
    assert.ok(arrSection?.includes(fileName), `${fileName} must remain mapped to All Rights Reserved`);
    assert.equal(ccSection?.includes(fileName), false, `${fileName} must not be mapped to CC BY-ND 4.0`);
  }
}
assert.match(mediaReadme, /No copyright or license\s+notice is burned into videos 1–4/);
assert.match(mediaReadme, /only audible soundtrack[\s\S]*synthesized from tone generators and mastered locally/i);
assert.match(mediaReadme, /No third-party stock\s+images, stock video, music, sound samples, fonts, or logos are embedded/);
const calls = [];
const surface = await startLocalControlSurface(
  { enabled: true, host: "127.0.0.1", port: 0 },
  async (toolName, argumentsValue, caller) => {
    calls.push({ toolName, argumentsValue, caller });
    return { online: true };
  },
);

try {
  const pageResponse = await fetch(surface.url);
  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  const dashboard = html.match(/<section class="tab-panel" id="panel-dashboard"[\s\S]*?<\/section>\s*<section class="tab-panel" id="panel-configuration"/)?.[0];
  const configuration = html.match(/<section class="tab-panel" id="panel-configuration"[\s\S]*?<\/section>\s*<section class="tab-panel" id="panel-help"/)?.[0];
  const help = html.match(/<section class="tab-panel" id="panel-help"[\s\S]*?<\/main>/)?.[0];
  assert.ok(dashboard?.includes("Inspect HawkSpan"));
  assert.ok(configuration?.includes("Behavior and compatibility"));
  assert.ok(help?.includes("Video guides"));
  assert.ok(help?.includes("From cables to SimpleTuner"));
  assert.ok(help?.includes("sample transfer, LoRA checkpoints, and verified results returned from the headless worker"));
  assert.equal((help?.match(/<video /g) || []).length, 5);
  assert.equal((help?.match(/controls preload="metadata"/g) || []).length, 5);
  assert.equal(/autoplay/.test(help || ""), false);
  assert.ok(html.includes("grid-template-columns:repeat(2,minmax(0,1fr))"));
  assert.ok(html.includes("grid-template-columns:minmax(0,1fr)"));
  assert.ok(html.includes(".video-guide{min-width:0"));
  assert.ok(html.includes(".video-guide video{display:block;min-width:0;width:100%;max-width:100%"));
  assert.ok(html.includes(".help-grid,.video-guide-grid{grid-template-columns:minmax(0,1fr)}"));
  assert.ok(html.includes(".video-guide:last-child{grid-column:1/-1}"));
  assert.ok(html.includes(".video-guide:last-child video{width:calc(50% - 7px);margin-inline:auto}"));
  assert.equal(/<video /.test(dashboard || ""), false);
  assert.equal(/<video /.test(configuration || ""), false);
  for (const [urlPath] of videos) assert.ok(help?.includes(`src="${urlPath}"`));

  for (const [urlPath, fileName] of videos) {
    const size = fs.statSync(path.join(repository, "static", "media", "help", fileName)).size;
    const head = await fetch(new URL(urlPath, surface.url), { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "video/mp4");
    assert.equal(head.headers.get("content-length"), String(size));
    assert.equal(head.headers.get("accept-ranges"), "bytes");
    assert.equal(head.headers.get("x-content-type-options"), "nosniff");
    assert.match(head.headers.get("cache-control") || "", /private/);

    const partial = await fetch(new URL(urlPath, surface.url), { headers: { range: "bytes=0-31" } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-length"), "32");
    assert.equal(partial.headers.get("content-range"), `bytes 0-31/${size}`);
    assert.equal((await partial.arrayBuffer()).byteLength, 32);
  }

  for (const urlPath of [
    "/media/help/not-allowlisted.mp4",
    "/media/help/%2e%2e%2fwhat-hawkspan-does.mp4",
    "/media/help/..%2fwhat-hawkspan-does.mp4",
  ]) {
    const response = await fetch(new URL(urlPath, surface.url), { redirect: "manual" });
    assert.equal(response.status, 404, `${urlPath} must not be served`);
  }
  const disallowedMethod = await fetch(new URL(videos[0][0], surface.url), { method: "POST" });
  assert.equal(disallowedMethod.status, 404);

  const token = html.match(/const token=("[a-f0-9]{64}");/)?.[1];
  assert.ok(token, "control token should remain embedded in the local page");
  const apiResponse = await fetch(new URL("/api/call", surface.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hawkspan-token": JSON.parse(token),
    },
    body: JSON.stringify({ tool_name: "link_status", arguments: {} }),
  });
  assert.equal(apiResponse.status, 200);
  assert.deepEqual(await apiResponse.json(), { online: true });
  assert.deepEqual(calls, [{ toolName: "link_status", argumentsValue: {}, caller: "html" }]);
} finally {
  await surface.close();
}

process.stdout.write("hawkspan local-control Help videos passed\n");
