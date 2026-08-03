import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const helpVideoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "static",
  "media",
  "help",
);
const helpVideos = new Map([
  ["/media/help/what-hawkspan-does.mp4", "what-hawkspan-does.mp4"],
  ["/media/help/hawkspan-profiles.mp4", "hawkspan-profiles.mp4"],
  ["/media/help/hawkspan-detailed-configuration.mp4", "hawkspan-detailed-configuration.mp4"],
  ["/media/help/hawkspan-connections.mp4", "hawkspan-connections.mp4"],
  ["/media/help/hawkspan-bottom-up-workflow.mp4", "hawkspan-bottom-up-workflow.mp4"],
]);

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'",
  });
  response.end(body);
}

function sendHelpVideo(request, response, fileName) {
  const filePath = path.join(helpVideoRoot, fileName);
  const size = fs.statSync(filePath).size;
  const headers = {
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
  };
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      response.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": 0 });
      response.end();
      return;
    }
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) {
        response.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": 0 });
        response.end();
        return;
      }
      start = Math.max(0, size - suffixLength);
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : end;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      response.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": 0 });
      response.end();
      return;
    }
    end = Math.min(end, size - 1);
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["content-length"] = end - start + 1;
  response.writeHead(status, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  fs.createReadStream(filePath, { start, end }).pipe(response);
}

function page(token, configuration) {
  const escapedToken = JSON.stringify(token);
  const profileToolNames = [
    "reset_configuration",
    "list_configuration_profiles",
    "save_configuration_profile",
    "apply_configuration_profile",
    "delete_configuration_profile",
  ];
  const profileManagementEnabled = !configuration.allowed_tools ||
    profileToolNames.every((name) => configuration.allowed_tools.includes(name));
  const applicationPresetToolNames = [
    "list_application_presets",
    "preview_application_preset",
    "apply_application_preset",
    "reset_application_preset",
  ];
  const applicationPresetManagementEnabled = !configuration.allowed_tools ||
    applicationPresetToolNames.every((name) => configuration.allowed_tools.includes(name));
  const connectionToolNames = [
    "get_connection_configuration",
    "update_connection_configuration",
  ];
  const connectionManagementEnabled = !configuration.allowed_tools ||
    connectionToolNames.every((name) => configuration.allowed_tools.includes(name));
  const routeLabels = JSON.stringify({
    primary: configuration.route_labels?.primary || "Primary",
    fallback: configuration.route_labels?.fallback || "Fallback",
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HawkSpan · Local control</title>
<style>
:root{color-scheme:dark;--ink:#f4f7fb;--muted:#9baabd;--panel:rgba(17,27,43,.82);--line:rgba(153,178,211,.17);--blue:#71b7ff;--blue2:#397eea;--green:#53dda3;--violet:#b794f6;--amber:#f6c76f;--coral:#ff8f82;--shadow:0 28px 80px rgba(0,0,0,.35)}
*{box-sizing:border-box}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
body{margin:0;min-height:100vh;font:15px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;color:var(--ink);background:radial-gradient(circle at 18% 4%,rgba(48,112,204,.28),transparent 34rem),radial-gradient(circle at 90% 90%,rgba(30,129,111,.18),transparent 30rem),#07101d}
body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.28;background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:32px 32px}
.shell{position:relative;width:min(940px,calc(100% - 32px));margin:0 auto;padding:42px 0 56px}
.masthead{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:26px}
.brand{display:flex;gap:15px;align-items:center}
.mark{display:grid;place-items:center;width:50px;height:50px;border:1px solid rgba(137,190,255,.3);border-radius:15px;background:linear-gradient(145deg,rgba(94,166,255,.24),rgba(35,80,140,.12));box-shadow:inset 0 1px rgba(255,255,255,.12),0 12px 36px rgba(33,112,217,.2);font-weight:800;font-size:21px;letter-spacing:-1px}
h1{margin:0;font-size:26px;letter-spacing:-.035em}h1 span{color:var(--muted);font-weight:500}
.subhead{margin:3px 0 0;color:var(--muted)}
.local-badge{display:flex;gap:8px;align-items:center;white-space:nowrap;margin-top:7px;padding:7px 11px;border:1px solid rgba(83,221,163,.25);border-radius:999px;background:rgba(28,118,87,.13);color:#a9f3d2;font-size:12px;font-weight:650}
.dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 4px rgba(83,221,163,.11)}
.notice{display:flex;gap:12px;align-items:flex-start;margin-bottom:18px;padding:14px 16px;border:1px solid rgba(113,183,255,.18);border-radius:14px;background:rgba(39,91,154,.12);color:#c6d5e8}
.notice strong{color:#e8f3ff}.shield{color:var(--blue);font-size:18px}
.top-nav{position:sticky;z-index:10;top:12px;display:flex;gap:7px;margin:0 0 18px;padding:6px;border:1px solid rgba(153,178,211,.2);border-radius:14px;background:rgba(8,17,30,.9);box-shadow:0 12px 34px rgba(0,0,0,.28);backdrop-filter:blur(18px)}.nav-tab{flex:1;padding:10px 14px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--muted);font-weight:700;cursor:pointer}.nav-tab:hover{color:#fff;background:rgba(113,183,255,.08)}.nav-tab[aria-selected="true"]{border-color:rgba(113,183,255,.34);background:linear-gradient(135deg,rgba(57,126,234,.28),rgba(125,83,197,.2));color:#fff;box-shadow:inset 0 1px rgba(255,255,255,.08)}.tab-panel[hidden]{display:none}.dashboard-grid{grid-template-columns:minmax(0,1fr)}
.grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(260px,.65fr);gap:18px}
.card{position:relative;border:1px solid var(--line);border-radius:20px;background:var(--panel);box-shadow:var(--shadow);backdrop-filter:blur(18px);overflow:hidden}.card:before{content:"";position:absolute;inset:0 0 auto;height:2px;background:linear-gradient(90deg,var(--blue2),var(--violet),var(--green));opacity:.72}
.card-head{padding:20px 22px 17px;border-bottom:1px solid var(--line)}
.eyebrow{margin:0 0 3px;color:var(--blue);font-size:11px;font-weight:750;letter-spacing:.12em;text-transform:uppercase}
h2{margin:0;font-size:18px;letter-spacing:-.015em}.card-head p{margin:4px 0 0;color:var(--muted);font-size:13px}
.card-body{padding:21px 22px}
label{display:flex;align-items:center;gap:7px;margin:0 0 7px;color:#cfdae8;font-size:13px;font-weight:650}
.help{position:relative;display:inline-grid;place-items:center;width:17px;height:17px;border:1px solid rgba(155,170,189,.38);border-radius:50%;color:var(--muted);font-size:11px;cursor:help}
.help:focus:after,.help:hover:after{content:attr(data-tip);position:absolute;z-index:5;left:24px;top:-10px;width:230px;padding:9px 11px;border:1px solid #34455d;border-radius:9px;background:#101b2b;color:#e8eef6;font-size:12px;font-weight:450;line-height:1.4;box-shadow:0 10px 30px rgba(0,0,0,.4)}
.quick{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:19px}
.tool-choice{padding:7px 11px;border:1px solid var(--line);border-radius:9px;background:rgba(255,255,255,.035);color:#cad6e5;font:inherit;font-size:13px;cursor:pointer}.tool-choice:nth-child(3n+1){border-color:rgba(113,183,255,.28);background:rgba(61,133,224,.09)}.tool-choice:nth-child(3n+2){border-color:rgba(183,148,246,.25);background:rgba(125,83,197,.08)}.tool-choice:nth-child(3n){border-color:rgba(83,221,163,.24);background:rgba(28,118,87,.08)}.tool-choice:hover{border-color:rgba(113,183,255,.65);color:#fff;background:rgba(61,133,224,.17);transform:translateY(-1px)}
.human-result{margin-top:18px;padding:16px;border:1px solid rgba(113,183,255,.27);border-radius:13px;background:linear-gradient(135deg,rgba(42,100,170,.18),rgba(93,61,148,.11) 58%,rgba(28,118,87,.1))}.human-result h3{margin:0 0 4px;color:#f7fbff;font-size:15px}.human-result p{margin:0;color:#c2d2e6;font-size:13px}.checked{display:block;margin-top:8px;color:#9fb5cd;font-size:11px}
.routes{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:13px}.route{padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:rgba(3,9,17,.35)}.route-top{display:flex;justify-content:space-between;gap:10px;align-items:center}.route-name{font-weight:700}.route-state{display:flex;gap:6px;align-items:center;color:#a9f3d2;font-size:11px;font-weight:700}.route-state.bad{color:#ffb0ac}.route-state .dot{width:6px;height:6px}.route-state.bad .dot{background:#ff716c;box-shadow:0 0 0 4px rgba(255,113,108,.1)}.route-detail{margin-top:3px;color:var(--muted);font-size:11px}
input,textarea,button{font:inherit}
input,textarea{display:block;width:100%;border:1px solid rgba(155,170,189,.22);border-radius:11px;outline:none;background:rgba(3,9,17,.55);color:#eef5ff;box-shadow:inset 0 1px 4px rgba(0,0,0,.2)}
input{padding:11px 12px;margin-bottom:17px}textarea{min-height:118px;padding:12px;resize:vertical;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
input:focus,textarea:focus{border-color:rgba(113,183,255,.68);box-shadow:0 0 0 3px rgba(65,139,231,.13)}
.actions{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-top:16px}.hint{color:var(--muted);font-size:12px}
#call{display:flex;align-items:center;gap:8px;padding:10px 16px;border:0;border-radius:10px;background:linear-gradient(180deg,#5aa6ff,#397eea);color:white;font-weight:720;cursor:pointer;box-shadow:0 9px 24px rgba(57,126,234,.27)}#call:hover{filter:brightness(1.08)}#call:disabled{opacity:.6;cursor:wait}
.side{display:flex;flex-direction:column;gap:18px}
.guide{padding:20px 21px;background:linear-gradient(155deg,rgba(48,94,158,.15),rgba(17,27,43,.3))}.guide .eyebrow{color:var(--violet)}.guide h2{font-size:16px;margin-bottom:13px}.guide ol{margin:0;padding-left:19px;color:#c6d1df}.guide li{padding:0 0 10px}.guide li::marker{color:var(--violet);font-weight:800}.guide li:last-child{padding-bottom:0}.guide strong{color:#f1f6fc}
.safety{padding:18px 20px;background:linear-gradient(145deg,rgba(28,118,87,.14),rgba(17,27,43,.25))}.safety-title{display:flex;align-items:center;gap:9px;margin-bottom:8px;color:#c8f8e3;font-weight:700}.safety p{margin:0;color:var(--muted);font-size:13px}
.result{margin-top:18px}.result-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.result-head span{color:var(--muted);font-size:12px}
#output{min-height:150px;max-height:390px;overflow:auto;margin:0;padding:15px;border:1px solid var(--line);border-radius:12px;background:#050b14;color:#b9c9dc;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}
.config-intro{display:flex;justify-content:space-between;gap:18px;align-items:center}.config-actions,.profile-actions{display:flex;flex-wrap:wrap;gap:9px}.secondary,.save-config,.danger{padding:9px 13px;border-radius:9px;cursor:pointer}.secondary{border:1px solid rgba(183,148,246,.35);background:rgba(125,83,197,.12);color:#e2d5ff}.save-config{border:0;background:linear-gradient(180deg,#57cfa0,#29956f);color:#fff;font-weight:720}.danger{border:1px solid rgba(255,143,130,.36);background:rgba(160,61,56,.13);color:#ffc1bb}.secondary:disabled,.save-config:disabled,.danger:disabled{opacity:.45;cursor:not-allowed}.profile-manager,.connection-manager{margin-bottom:16px;padding:17px;border:1px solid rgba(113,183,255,.22);border-radius:14px;background:linear-gradient(135deg,rgba(39,91,154,.13),rgba(125,83,197,.08))}.profile-manager h3,.connection-manager h3{display:flex;align-items:center;gap:7px;margin:0 0 4px;font-size:15px}.profile-manager>p,.connection-manager>p{margin:0 0 13px;color:var(--muted);font-size:12px}.connection-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px}.connection-route{padding:13px;border:1px solid var(--line);border-radius:11px;background:rgba(3,9,17,.28)}.connection-route>label:first-child{justify-content:space-between;margin-bottom:10px}.connection-route input[type=checkbox]{width:auto;margin:0;accent-color:var(--blue2)}.connection-route input[type=text]{margin:0 0 10px;padding:9px 10px}.connection-route input[type=text]:last-child{margin-bottom:0}.connection-summary{margin:12px 0;color:#c5d4e6;font-size:12px}.profile-picker{display:grid;grid-template-columns:minmax(220px,1fr) minmax(180px,.7fr);gap:11px}.profile-field label{margin-bottom:5px}.profile-field select,.profile-field input{width:100%;margin:0;padding:9px 10px;border:1px solid rgba(155,170,189,.22);border-radius:9px;background:#091321;color:#eef5ff}.profile-preview{margin:12px 0;padding:12px 13px;border-left:3px solid var(--blue);border-radius:8px;background:rgba(3,9,17,.32)}.profile-preview strong{display:block;font-size:13px}.profile-preview p{margin:3px 0 0;color:#b9c9dc;font-size:12px}.profile-badge{display:inline-block;margin-left:7px;padding:2px 6px;border:1px solid rgba(83,221,163,.28);border-radius:999px;color:#a9f3d2;font-size:9px;text-transform:uppercase;letter-spacing:.08em}.config-state{margin:0 0 16px;padding:11px 13px;border-left:3px solid var(--violet);border-radius:7px;background:rgba(125,83,197,.09);color:#cbd7e7;font-size:13px}.config-groups{display:grid;grid-template-columns:1fr 1fr;gap:14px}.config-group{padding:15px;border:1px solid var(--line);border-radius:13px;background:rgba(3,9,17,.28)}.config-group h3{margin:0 0 11px;color:#dce9fa;font-size:14px}.config-row{display:flex;justify-content:space-between;gap:14px;align-items:center;padding:8px 0;border-top:1px solid rgba(153,178,211,.1)}.config-row:first-of-type{border-top:0}.config-copy strong{display:flex;align-items:center;gap:6px;font-size:12px}.config-copy small{display:block;color:var(--muted);font-size:11px}.config-copy .help{flex:0 0 auto}.config-row select,.config-row input[type=text]{width:min(220px,48%);margin:0;padding:8px 9px;border:1px solid rgba(155,170,189,.22);border-radius:8px;background:#091321;color:#eef5ff}.direction{display:grid;grid-template-columns:auto auto;gap:7px 12px;color:var(--muted);font-size:10px;text-align:center}.direction label,.switch-label{margin:0;font-size:11px}.direction input,.switch-label input{accent-color:var(--blue2)}.config-warning{color:var(--amber)!important}.help-grid{grid-template-columns:1fr 1fr}.help-grid .guide,.help-grid .safety{min-height:100%}.help-copy{padding:20px 21px}.help-copy h2{font-size:16px}.help-copy p,.help-copy li{color:#c6d1df;font-size:13px}.help-copy code{color:#b9d8ff}
.video-guides{min-width:0;grid-column:1/-1;padding:20px 21px}.video-guides-head{margin-bottom:15px}.video-guides-head p{margin:4px 0 0;color:var(--muted);font-size:13px}.video-guide-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.video-guide{min-width:0;padding:14px;border:1px solid var(--line);border-radius:14px;background:rgba(3,9,17,.3)}.video-guide:last-child{grid-column:1/-1}.video-guide h3{margin:0 0 3px;font-size:14px}.video-guide p{min-height:40px;margin:0 0 11px;color:#b9c9dc;font-size:12px}.video-guide video{display:block;min-width:0;width:100%;max-width:100%;aspect-ratio:16/9;border:1px solid rgba(153,178,211,.16);border-radius:10px;background:#050b14}.video-guide:last-child video{width:calc(50% - 7px);margin-inline:auto}
@media(max-width:720px){.shell{padding-top:25px}.masthead{display:block}.local-badge{display:inline-flex;margin:15px 0 0}.grid{grid-template-columns:1fr}.routes{grid-template-columns:1fr}.actions{align-items:flex-end}.hint{max-width:55%}}
@media(max-width:720px){.config-intro{display:block}.config-actions{margin-top:12px}.config-groups,.profile-picker,.connection-grid{grid-template-columns:1fr}.config-row{align-items:flex-start;flex-direction:column}.config-row select,.config-row input[type=text]{width:100%}}
@media(max-width:720px){.help-grid,.video-guide-grid{grid-template-columns:minmax(0,1fr)}.video-guide:last-child{grid-column:auto}.video-guide:last-child video{width:100%}.video-guide p{min-height:0}}
</style>
</head>
<body>
<main class="shell">
  <header class="masthead">
    <div class="brand">
      <div class="mark" aria-hidden="true">HS</div>
      <div><h1>HawkSpan <span>Local Control</span></h1><p class="subhead">A private control point for your paired Macs.</p></div>
    </div>
    <div class="local-badge" title="This page is available only from this Mac."><span class="dot"></span> Localhost only</div>
  </header>
  <nav class="top-nav" role="tablist" aria-label="HawkSpan sections">
    <button class="nav-tab" id="tab-dashboard" role="tab" aria-selected="true" aria-controls="panel-dashboard" data-tab="dashboard" type="button">Dashboard</button>
    <button class="nav-tab" id="tab-configuration" role="tab" aria-selected="false" aria-controls="panel-configuration" data-tab="configuration" type="button">Configuration</button>
    <button class="nav-tab" id="tab-help" role="tab" aria-selected="false" aria-controls="panel-help" data-tab="help" type="button">Help</button>
  </nav>
  <section class="tab-panel" id="panel-dashboard" role="tabpanel" aria-labelledby="tab-dashboard" data-panel="dashboard">
    <div class="notice"><span class="shield" aria-hidden="true">◆</span><div><strong>High-trust environment.</strong> HawkSpan is designed for two computers under the same ownership, typically in the same room. This page never listens on your local network.</div></div>
    <div class="grid dashboard-grid">
    <section class="card">
      <div class="card-head"><p class="eyebrow">Command console</p><h2>Inspect HawkSpan</h2><p>Choose an approved tool and run it against this Mac.</p></div>
      <div class="card-body">
        <label>Quick checks <span class="help" tabindex="0" data-tip="These shortcuts fill in the tool name and safe default arguments for you.">?</span></label>
        <div class="quick">
          <button class="tool-choice" data-tool="mcp_status" type="button" title="Confirm that this HawkSpan MCP service is responding.">MCP status</button>
          <button class="tool-choice" data-tool="link_status" type="button" title="Check both configured connections, the active route, and queue counts.">Connection status</button>
          <button class="tool-choice" data-tool="application_plugin_status" type="button" title="See which application plugins are installed and available.">Plugin status</button>
          <button class="tool-choice" data-tool="list_messages" data-args='{"limit":10}' type="button" title="Show the ten most recent durable messages.">Messages</button>
          <button class="tool-choice" data-tool="list_jobs" data-args='{"limit":10}' type="button" title="Show the ten most recent tracked jobs.">Jobs</button>
          <button class="tool-choice" data-tool="list_artifacts" data-args='{"limit":10}' type="button" title="Show the ten most recent registered artifacts.">Artifacts</button>
          <button class="tool-choice" data-tool="list_audit_events" data-args='{"limit":10}' type="button" title="Show the ten most recent HawkSpan audit events.">Audit history</button>
        </div>
        <label for="tool">Tool name <span class="help" tabindex="0" data-tip="The exact HawkSpan tool to call. Only tools approved in the local HTML allowlist can run here.">?</span></label>
        <input id="tool" value="application_plugin_status" spellcheck="false" aria-describedby="tool-help">
        <label for="arguments">Arguments (JSON) <span class="help" tabindex="0" data-tip="Optional structured inputs for the tool. Leave this as an empty object when a tool needs no arguments.">?</span></label>
        <textarea id="arguments" spellcheck="false">{}</textarea>
        <div class="actions"><span class="hint" id="tool-help">Only locally approved tools are accepted.</span><button id="call" type="button"><span aria-hidden="true">▶</span> Run tool</button></div>
        <section class="human-result" id="human-result" aria-live="polite">
          <h3>Plain-language result</h3>
          <p>Run a quick check and HawkSpan will explain the result here.</p>
        </section>
        <div class="result">
          <div class="result-head"><label for="output">Technical result (unchanged)</label><span aria-live="polite" id="state">Ready</span></div>
          <pre id="output" aria-live="polite">Choose a quick check or enter an approved tool, then select “Run tool.”</pre>
        </div>
      </div>
    </section>
    </div>
  </section>
  <section class="tab-panel" id="panel-configuration" role="tabpanel" aria-labelledby="tab-configuration" data-panel="configuration" hidden>
    <section class="card config-card">
      <div class="card-head config-intro">
        <div><p class="eyebrow">Configuration</p><h2>Behavior and compatibility</h2><p>Current HawkSpan behavior remains the default. Change only the capabilities you intend to restore or restrict.</p></div>
        <div class="config-actions"><button class="secondary" id="reload-config" type="button" title="Discard unsaved screen changes and reload the active HawkSpan configuration.">Reload</button><button class="save-config" id="save-config" type="button" title="Validate and save the individual role and capability controls shown below.">Save changes</button></div>
      </div>
      <div class="card-body">
        <section class="connection-manager" aria-labelledby="connections-heading">
          <h3 id="connections-heading">Connections <span class="help" tabindex="0" role="note" aria-label="Help: Configure one or two ways for HawkSpan to reach the other Mac. At least one connection must remain enabled." data-tip="Configure one or two ways for HawkSpan to reach the other Mac. At least one connection must remain enabled.">?</span></h3>
          <p>Use either connection by itself, or enable both for automatic primary-to-fallback routing.</p>
          <div class="connection-grid">
            <section class="connection-route">
              <label for="connection-primary-enabled"><strong>Primary connection</strong><span><input id="connection-primary-enabled" type="checkbox"> Enabled</span></label>
              <label for="connection-primary-label">Display name <span class="help" tabindex="0" role="note" aria-label="Help: A human-readable name such as Thunderbolt, Ethernet, Wi-Fi, or Office LAN." data-tip="A human-readable name such as Thunderbolt, Ethernet, Wi-Fi, or Office LAN.">?</span></label>
              <input id="connection-primary-label" type="text" maxlength="40">
              <label for="connection-primary-host">Host or address <span class="help" tabindex="0" role="note" aria-label="Help: The hostname or IP address HawkSpan uses to reach the peer over this connection." data-tip="The hostname or IP address HawkSpan uses to reach the peer over this connection.">?</span></label>
              <input id="connection-primary-host" type="text" maxlength="253" spellcheck="false">
            </section>
            <section class="connection-route">
              <label for="connection-fallback-enabled"><strong>Fallback connection</strong><span><input id="connection-fallback-enabled" type="checkbox"> Enabled</span></label>
              <label for="connection-fallback-label">Display name <span class="help" tabindex="0" role="note" aria-label="Help: This name identifies the second connection when automatic fallback is available." data-tip="This name identifies the second connection when automatic fallback is available.">?</span></label>
              <input id="connection-fallback-label" type="text" maxlength="40">
              <label for="connection-fallback-host">Host or address <span class="help" tabindex="0" role="note" aria-label="Help: The hostname or IP address for the optional fallback connection." data-tip="The hostname or IP address for the optional fallback connection.">?</span></label>
              <input id="connection-fallback-host" type="text" maxlength="253" spellcheck="false">
            </section>
          </div>
          <p class="connection-summary" id="connection-summary" aria-live="polite">Loading connection settings…</p>
          <button class="save-config" id="save-connections" type="button" title="Review and confirm before saving connection availability, names, or addresses.">Save connection settings</button>
        </section>
        <section class="profile-manager" aria-labelledby="profiles-heading">
          <h3 id="profiles-heading">Configuration profiles <span class="help" tabindex="0" role="note" aria-label="Help: Profiles contain only HawkSpan role and capability choices. They never replace peer addresses, SSH identity, paths, plugins, tokens, or local-control settings." data-tip="Profiles contain only HawkSpan role and capability choices. They never replace peer addresses, SSH identity, paths, plugins, tokens, or local-control settings.">?</span></h3>
          <p>Start from a reviewed use case or save this Mac’s current settings under your own name.</p>
          <div class="profile-picker">
            <div class="profile-field"><label for="profile-select">Available profile <span class="help" tabindex="0" role="note" aria-label="Help: Choose a reviewed built-in starting point or a profile previously saved on this Mac." data-tip="Choose a reviewed built-in starting point or a profile previously saved on this Mac.">?</span></label><select id="profile-select"><option value="">Loading profiles…</option></select></div>
            <div class="profile-field"><label for="profile-name">Save current settings as <span class="help" tabindex="0" role="note" aria-label="Help: Names the active role and capability settings so you can apply them again later." data-tip="Names the active role and capability settings so you can apply them again later.">?</span></label><input id="profile-name" maxlength="80" placeholder="Example: Studio worker"></div>
          </div>
          <div class="profile-preview" id="profile-preview" aria-live="polite"><strong>Select a profile</strong><p>Its purpose and effect will appear here before you apply it.</p></div>
          <div class="profile-actions">
            <button class="save-config" id="apply-profile" type="button" title="Preview and confirm before replacing the active role and capability choices." disabled>Apply selected profile</button>
            <button class="secondary" id="save-profile" type="button" title="Save the currently active role and capability choices under the entered name.">Save named profile</button>
            <button class="danger" id="delete-profile" type="button" title="Delete a user-created profile after confirmation; built-in profiles cannot be deleted." disabled>Delete selected profile</button>
            <button class="danger" id="reset-config" type="button" title="After confirmation, remove role and capability overrides and return to inherited defaults.">Reset flags to defaults</button>
          </div>
        </section>
        <section class="profile-manager" aria-labelledby="application-presets-heading">
          <h3 id="application-presets-heading">Application quick starts <span class="help" tabindex="0" role="note" aria-label="Help: Reviewed application plugins can provide named presets that configure only approved roles, capabilities, peer tools, and that plugin’s enabled operations." data-tip="Reviewed application plugins can provide named presets that configure only approved roles, capabilities, peer tools, and that plugin’s enabled operations.">?</span></h3>
          <p>Choose a preset supplied by an installed, reviewed plugin. Connections, credentials, paths, tokens, local-control settings, plugin configuration, and application data are never part of a preset.</p>
          <div class="profile-picker">
            <div class="profile-field"><label for="application-preset-select">Available quick start <span class="help" tabindex="0" role="note" aria-label="Help: Only presets declared by installed and validated application plugins appear here." data-tip="Only presets declared by installed and validated application plugins appear here.">?</span></label><select id="application-preset-select"><option value="">Loading application presets…</option></select></div>
          </div>
          <div class="profile-preview" id="application-preset-preview" aria-live="polite"><strong>Select an application quick start</strong><p>Its purpose, restrictions, and preserved settings will appear here before you apply it.</p></div>
          <div class="profile-actions">
            <button class="save-config" id="apply-application-preset" type="button" title="Preview and confirm before applying only the approved application settings." disabled>Apply quick start</button>
            <button class="danger" id="reset-application-preset" type="button" title="After confirmation, reset the selected preset’s role, capability, and operation restrictions to inherited defaults." disabled>Reset quick start</button>
          </div>
        </section>
        <p class="config-state" id="config-state" aria-live="polite">Loading the effective configuration…</p>
        <div class="config-groups" id="config-groups" hidden></div>
      </div>
    </section>
  </section>
  <section class="tab-panel" id="panel-help" role="tabpanel" aria-labelledby="tab-help" data-panel="help" hidden>
    <div class="grid help-grid">
      <section class="card video-guides" aria-labelledby="video-guides-title">
        <div class="video-guides-head"><p class="eyebrow">Video guides</p><h2 id="video-guides-title">See HawkSpan in action</h2><p>Five quick guides explain the essentials. Pause or replay any section as needed.</p></div>
        <div class="video-guide-grid">
          <article class="video-guide"><h3>What HawkSpan does</h3><p>See how HawkSpan creates a private control point for your paired Macs.</p><video controls preload="metadata" title="What HawkSpan does video guide" aria-label="What HawkSpan does video guide"><source src="/media/help/what-hawkspan-does.mp4" type="video/mp4">Your browser does not support HTML5 video.</video></article>
          <article class="video-guide"><h3>The four profiles</h3><p>Choose a reviewed starting point for the way your two Macs work together.</p><video controls preload="metadata" title="HawkSpan profiles video guide" aria-label="HawkSpan profiles video guide"><source src="/media/help/hawkspan-profiles.mp4" type="video/mp4">Your browser does not support HTML5 video.</video></article>
          <article class="video-guide"><h3>Detailed configuration</h3><p>Understand roles, capabilities, authorization, automation, and transport controls.</p><video controls preload="metadata" title="HawkSpan detailed configuration video guide" aria-label="HawkSpan detailed configuration video guide"><source src="/media/help/hawkspan-detailed-configuration.mp4" type="video/mp4">Your browser does not support HTML5 video.</video></article>
          <article class="video-guide"><h3>Connections and fallback</h3><p>Use Thunderbolt or Ethernet alone, or enable both for automatic redundancy.</p><video controls preload="metadata" title="HawkSpan connections and fallback video guide" aria-label="HawkSpan connections and fallback video guide"><source src="/media/help/hawkspan-connections.mp4" type="video/mp4">Your browser does not support HTML5 video.</video></article>
          <article class="video-guide"><h3>From cables to SimpleTuner</h3><p>See the complete bottom-up path: two network routes, HawkSpan and MCP controls, sample transfer, LoRA checkpoints, and verified results returned from the headless worker.</p><video controls preload="metadata" title="HawkSpan and SimpleTuner bottom-up workflow video guide" aria-label="HawkSpan and SimpleTuner bottom-up workflow video guide"><source src="/media/help/hawkspan-bottom-up-workflow.mp4" type="video/mp4">Your browser does not support HTML5 video.</video></article>
        </div>
      </section>
      <section class="card guide"><p class="eyebrow">Help</p><h2>Getting started</h2><ol><li><strong>Check the connection</strong> to confirm each enabled route.</li><li>Use the other shortcuts to inspect <strong>plugins and activity</strong>.</li><li>Read the plain-language explanation, with the original technical result below it.</li></ol></section>
      <section class="card safety"><div class="safety-title"><span class="dot"></span> Private by design</div><p>Requests stay on this Mac and use the same guarded HawkSpan handlers as agent tools. Hover or focus any <strong>?</strong> for help.</p></section>
      <section class="card help-copy"><p class="eyebrow">Configuration help</p><h2>Profiles and flags</h2><p>Built-in profiles are reviewed starting points for common two-Mac arrangements. A named profile records only role and approved feature settings, so it cannot overwrite connection or installation details.</p><ul><li><strong>Apply</strong> replaces the active role and feature choices after confirmation.</li><li><strong>Reset</strong> returns flags to inherited symmetric defaults after confirmation.</li><li><strong>Save changes</strong> writes individual controls shown on the Configuration tab.</li></ul></section>
      <section class="card help-copy"><p class="eyebrow">More detail</p><h2>Understanding each option</h2><p>Hover or keyboard-focus the <strong>?</strong> beside any option for a concise explanation. The repository’s <code>docs/CONFIGURATION-FLAGS.md</code> provides the full reference for agents, installers, and manual administrators.</p></section>
      <section class="card help-copy"><p class="eyebrow">Connection help</p><h2>One connection or automatic fallback</h2><p>Enable only the route that exists, or enable both to try the primary route first and automatically fall back to the second. At least one enabled route must have a host or address. Connection settings are never changed by behavioral profiles.</p></section>
    </div>
  </section>
</main>
<script>
const token=${escapedToken};
const routeLabels=${routeLabels};
const profileManagementEnabled=${JSON.stringify(profileManagementEnabled)};
const applicationPresetManagementEnabled=${JSON.stringify(applicationPresetManagementEnabled)};
const connectionManagementEnabled=${JSON.stringify(connectionManagementEnabled)};
let loadedConfiguration=null;
let configurationProfiles=[];
let applicationPresets=[];
const tabs=[...document.querySelectorAll(".nav-tab")];
function selectTab(name,{updateHash=true}={}){
  const selected=tabs.some(tab=>tab.dataset.tab===name)?name:"dashboard";
  tabs.forEach(tab=>{const active=tab.dataset.tab===selected;tab.setAttribute("aria-selected",String(active));tab.tabIndex=active?0:-1});
  document.querySelectorAll(".tab-panel").forEach(panel=>{panel.hidden=panel.dataset.panel!==selected});
  if(updateHash)history.replaceState(null,"","#"+selected);
}
tabs.forEach((tab,index)=>{
  tab.addEventListener("click",()=>selectTab(tab.dataset.tab));
  tab.addEventListener("keydown",event=>{
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    event.preventDefault();
    const next=event.key==="Home"?0:event.key==="End"?tabs.length-1:(index+(event.key==="ArrowRight"?1:-1)+tabs.length)%tabs.length;
    tabs[next].focus();selectTab(tabs[next].dataset.tab);
  });
});
selectTab(location.hash.slice(1),{updateHash:false});
const directionalFlags=[
  ["allow_peer_commands","Remote commands","Allow commands received from or sent to the peer."],
  ["allow_peer_wakeup","Task wakeups","Allow either Mac to wake the configured task on the other."],
  ["allow_peer_messages","Messages","Exchange durable messages."],
  ["allow_peer_acknowledgements","Acknowledgements","Confirm receipt of durable messages."],
  ["allow_peer_jobs","Jobs","Create and update durable peer jobs."],
  ["allow_peer_artifact_send","Artifact sending","Send registered artifacts to the peer."],
  ["allow_peer_artifact_receive","Artifact receiving","Accept and verify peer artifacts."],
  ["enable_broad_run_command","Broad commands","Expose the general trusted-machine command tool."]
];
const booleanFlags=[
  ["require_authorized_job_for_all_commands","Authorize every command","Require a recorded authorized job for routine and consequential commands."],
  ["require_authorized_job_for_consequential_commands","Authorize consequential commands","Require a recorded authorized job for commands marked consequential."],
  ["enable_background_outbox","Background outbox","Retry queued work automatically."],
  ["enable_background_artifact_sender","Background artifact sender","Send queued artifacts automatically."],
  ["enable_background_artifact_receiver","Background artifact receiver","Import delivered artifacts automatically."],
  ["enable_scoped_operation_adapters","Scoped adapters","Allow manifest-bound application operations."],
  ["audit_command_content","Record command text","Keep full command text in the audit history."],
  ["strict_host_key_checking","Strict host identity","Keep enabled to require the pinned fingerprint. Disabling trusts the first previously unseen peer key."]
];
const attributeText=value=>String(value).replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;").replaceAll(">","&gt;");
const tooltip=help=>'<span class="help" tabindex="0" role="note" aria-label="Help: '+attributeText(help)+'" data-tip="'+attributeText(help)+'">?</span>';
const makeSelect=(key,label,help,options)=>'<div class="config-row"><div class="config-copy"><strong>'+label+tooltip(help)+'</strong><small>'+help+'</small></div><select aria-label="'+attributeText(label)+'" data-config="'+key+'">'+options.map(option=>'<option value="'+option[0]+'">'+option[1]+'</option>').join("")+'</select></div>';
const groups=document.querySelector("#config-groups");
groups.innerHTML='<section class="config-group"><h3>Operating profile</h3>'+
  makeSelect("role_profile","Role profile","Symmetric is the current default; controller-worker enables asymmetric roles.",[["symmetric","Symmetric"],["controller-worker","Controller / worker"]])+
  makeSelect("node_role","This Mac’s role","Required for controller-worker mode; the controller initiates and the worker receives.",[["","Choose a role"],["controller","Controller"],["worker","Worker"]])+
  makeSelect("artifact_verification_mode","Artifact verification","Cached mode trusts the recorded digest when file size matches; Always provides the strongest recheck.",[["always","Always"],["on-change","When metadata changes"],["cached","Cached (size check only)"]])+
  makeSelect("wake_prompt_mode","Wake prompt","Choose whether a wakeup embeds the durable message body.",[["notification","Notification only"],["embedded-message","Embed message"]])+
  '<div class="config-row"><div class="config-copy"><strong>Inbound peer tools'+tooltip("Use current for HawkSpan’s built-in inbound list, or enter only the exact peer tool names this Mac should accept.")+'</strong><small>Use “current” or comma-separated exact tool names.</small></div><input type="text" aria-label="Inbound peer tools" data-tools="inbound"></div>'+
  '<div class="config-row"><div class="config-copy"><strong>Outbound peer tools'+tooltip("Use current for HawkSpan’s built-in outbound list, or enter only the exact tool names this Mac may request from its peer.")+'</strong><small>Use “current” or comma-separated exact tool names.</small></div><input type="text" aria-label="Outbound peer tools" data-tools="outbound"></div></section>'+
  '<section class="config-group"><h3>Direction-specific capabilities</h3>'+directionalFlags.map(([key,label,help])=>'<div class="config-row"><div class="config-copy"><strong>'+label+tooltip(help+" Inbound controls requests arriving from the peer; outbound controls requests sent to it.")+'</strong><small>'+help+'</small></div><div class="direction"><span>Inbound</span><span>Outbound</span><label><input type="checkbox" aria-label="'+attributeText(label)+' inbound" data-direction="'+key+'" data-side="inbound"></label><label><input type="checkbox" aria-label="'+attributeText(label)+' outbound" data-direction="'+key+'" data-side="outbound"></label></div></div>').join("")+'</section>'+
  '<section class="config-group"><h3>Authorization and automation</h3>'+booleanFlags.slice(0,7).map(([key,label,help])=>'<div class="config-row"><div class="config-copy"><strong>'+label+tooltip(help)+'</strong><small>'+help+'</small></div><label class="switch-label"><input type="checkbox" aria-label="'+attributeText(label)+'" data-boolean="'+key+'"> Enabled</label></div>').join("")+'</section>'+
  '<section class="config-group"><h3>Audit and transport</h3>'+booleanFlags.slice(7).map(([key,label,help])=>'<div class="config-row"><div class="config-copy"><strong>'+label+tooltip(help)+'</strong><small class="'+(key==="strict_host_key_checking"?"config-warning":"")+'">'+help+'</small></div><label class="switch-label"><input type="checkbox" aria-label="'+attributeText(label)+'" data-boolean="'+key+'"> Enabled</label></div>').join("")+'</section>';
document.querySelectorAll(".tool-choice").forEach(button=>button.addEventListener("click",()=>{
  document.querySelector("#tool").value=button.dataset.tool;
  document.querySelector("#arguments").value=button.dataset.args||"{}";
}));
function explain(tool,data){
  const checked='<span class="checked">Checked '+new Date().toLocaleString()+'</span>';
  const safe=value=>String(value??"").replace(/[&<>"']/g,character=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]));
  if(tool==="mcp_status"){
    return '<h3>'+(data.online?"HawkSpan MCP is online.":"HawkSpan MCP needs attention.")+'</h3><p>This is '+data.service+' '+data.version+' on <strong>'+data.node_id+'</strong>. Agent tools can reach this local MCP service.</p>'+checked;
  }
  if(tool==="link_status"){
    const primary=(data.routes||[]).find(route=>route.role==="primary")||{};
    const fallback=(data.routes||[]).find(route=>route.role==="fallback")||{};
    const ok=route=>route.transport_ready===true;
    const enabled=route=>route.enabled!==false;
    const label=(route,fallbackLabel)=>route.label||fallbackLabel;
    const active=safe(data.selected_route_role==="primary"?label(primary,routeLabels.primary):data.selected_route_role==="fallback"?label(fallback,routeLabels.fallback):"No route");
    const enabledRoutes=[primary,fallback].filter(enabled);
    const allHealthy=enabledRoutes.length>0&&enabledRoutes.every(ok);
    const route=(name,value)=>{
      const disabled=!enabled(value);
      const state=disabled?"Disabled":ok(value)?"Connected":"Needs attention";
      return '<div class="route"><div class="route-top"><span class="route-name">'+safe(name)+'</span><span class="route-state '+(!disabled&&!ok(value)?"bad":"")+'"><span class="dot"></span>'+safe(state)+'</span></div><div class="route-detail">'+safe(value.host||"Not configured")+(value.transport_error?" · "+safe(value.transport_error):"")+'</div></div>';
    };
    const heading=allHealthy?(enabledRoutes.length===2?"Both connections are healthy.":"The connection is healthy."):"A connection needs attention.";
    const fallbackNote=enabledRoutes.length===2?" Automatic fallback is available when both connections are healthy.":" Only the enabled connection will be used.";
    return '<h3>'+heading+'</h3><p>HawkSpan is currently using <strong>'+active+'</strong>.'+fallbackNote+'</p><div class="routes">'+route(label(primary,routeLabels.primary),primary)+route(label(fallback,routeLabels.fallback),fallback)+'</div>'+checked;
  }
  if(tool==="application_plugin_status"){
    const plugins=Array.isArray(data.plugins)?data.plugins:[];
    const rejected=Array.isArray(data.rejected)?data.rejected:[];
    return '<h3>'+(plugins.length?plugins.length+' application plugin'+(plugins.length===1?" is":"s are")+' available.':'No application plugins are installed yet.')+'</h3><p>HawkSpan core is working. '+(plugins.length?"The installed plugins add application-specific actions.":"Install a reviewed plugin to add application-specific actions.")+(rejected.length?" "+rejected.length+" plugin"+(rejected.length===1?" was":"s were")+" rejected.":"")+'</p>'+checked;
  }
  if(tool==="list_audit_events"){
    const events=Array.isArray(data)?data:[];
    if(!events.length)return '<h3>No recent activity to report.</h3><p>HawkSpan has not recorded any audit events in this view.</p>'+checked;
    const failures=events.filter(event=>/fail|error|reject|denied/i.test(String(event.result||"")));
    const kinds=[...new Set(events.map(event=>event.object_type).filter(Boolean))].map(kind=>String(kind).replaceAll("_"," "));
    const describe=event=>{
      const result=String(event.result||"recorded").replaceAll("_"," ");
      const subject=event.object_type==="peer_tool"?(event.object_id||"a remote tool"):event.object_type==="artifact"?"an artifact":event.object_type==="outbox"?"the outgoing queue":event.object_id||event.object_type||"an item";
      const verb=event.action==="call"?"ran":event.action==="receive"?"received":event.action==="flush"?"checked":event.action||"updated";
      const when=event.timestamp?new Date(event.timestamp).toLocaleString():"Time unavailable";
      return '<div class="route"><div class="route-top"><span class="route-name">'+safe(when)+'</span><span class="route-state '+(/fail|error|reject|denied/i.test(result)?"bad":"")+'"><span class="dot"></span>'+safe(result)+'</span></div><div class="route-detail">HawkSpan '+safe(verb)+' '+safe(subject)+'.</div></div>';
    };
    return '<h3>'+(failures.length?failures.length+' recent event'+(failures.length===1?" needs":"s need")+' attention.':'Recent HawkSpan activity looks healthy.')+'</h3><p>'+events.length+' event'+(events.length===1?" was":"s were")+' reviewed'+(kinds.length?", covering "+safe(kinds.join(", "))+".":".")+'</p><div class="routes">'+events.slice(0,5).map(describe).join("")+'</div>'+checked;
  }
  const labels={list_messages:"message",list_jobs:"job",list_artifacts:"artifact"};
  if(labels[tool]){
    const count=Array.isArray(data)?data.length:0;
    return '<h3>'+(count?count+' recent '+labels[tool]+(count===1?"":"s")+' found.':'No '+labels[tool]+'s to show.')+'</h3><p>'+(count?"The unchanged technical result below contains the details.":"There is currently nothing in this category that needs review.")+'</p>'+checked;
  }
  return '<h3>Tool completed.</h3><p>The unchanged technical result below contains the details.</p>'+checked;
}
async function configCall(toolName,argumentsValue={}){
  const response=await fetch("/api/call",{method:"POST",headers:{"content-type":"application/json","x-hawkspan-token":token},body:JSON.stringify({tool_name:toolName,arguments:argumentsValue})});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||"Configuration request failed");
  return data;
}
function toolsText(value){return value==="current"?"current":Array.isArray(value)?value.join(", "):""}
function toolsValue(value){
  const trimmed=value.trim();
  return !trimmed||trimmed==="current"?"current":trimmed.split(",").map(item=>item.trim()).filter(Boolean);
}
function showConfiguration(data){
  const features=data.features||{};
  document.querySelector('[data-config="role_profile"]').value=data.role_profile;
  document.querySelector('[data-config="node_role"]').value=data.node_role||"";
  document.querySelector('[data-config="artifact_verification_mode"]').value=features.artifact_verification_mode;
  document.querySelector('[data-config="wake_prompt_mode"]').value=features.wake_prompt_mode;
  document.querySelector('[data-tools="inbound"]').value=toolsText(features.allowed_peer_tools?.inbound);
  document.querySelector('[data-tools="outbound"]').value=toolsText(features.allowed_peer_tools?.outbound);
  directionalFlags.forEach(([key])=>["inbound","outbound"].forEach(side=>{
    document.querySelector('[data-direction="'+key+'"][data-side="'+side+'"]').checked=features[key]?.[side]===true;
  }));
  booleanFlags.forEach(([key])=>{document.querySelector('[data-boolean="'+key+'"]').checked=features[key]===true});
  groups.hidden=false;
  document.querySelector("#config-state").textContent="Showing the effective configuration currently used by HawkSpan.";
  loadedConfiguration=structuredClone(data);
}
async function loadConfiguration(){
  const state=document.querySelector("#config-state");
  state.textContent="Loading the effective configuration…";
  try{showConfiguration(await configCall("get_configuration"))}
  catch(error){state.textContent="Configuration could not be loaded: "+String(error.message||error)}
}
function connectionInput(role,key){return document.querySelector("#connection-"+role+"-"+key)}
function showConnectionConfiguration(data){
  for(const role of ["primary","fallback"]){
    const route=data.routes?.[role]||{};
    connectionInput(role,"enabled").checked=route.enabled===true;
    connectionInput(role,"label").value=route.label||"";
    connectionInput(role,"host").value=route.host||"";
  }
  document.querySelector("#connection-summary").textContent=data.automatic_fallback
    ?"Both connections are enabled. HawkSpan will try the primary connection first and use the fallback when needed."
    :"One connection is enabled. Automatic fallback is off.";
}
async function loadConnectionConfiguration(){
  const summary=document.querySelector("#connection-summary");
  const save=document.querySelector("#save-connections");
  if(!connectionManagementEnabled){
    summary.textContent="Connection editing needs an allowlist update. Add the two connection-configuration tools documented in docs/CONNECTIONS.md, then restart HawkSpan.";
    save.disabled=true;
    document.querySelectorAll(".connection-route input").forEach(input=>{input.disabled=true});
    return;
  }
  try{showConnectionConfiguration(await configCall("get_connection_configuration"))}
  catch(error){summary.textContent="Connection settings could not be loaded: "+String(error.message||error);save.disabled=true}
}
async function saveConnectionConfiguration(){
  const summary=document.querySelector("#connection-summary");
  const button=document.querySelector("#save-connections");
  const routes={};
  for(const role of ["primary","fallback"]){
    routes[role]={
      enabled:connectionInput(role,"enabled").checked,
      label:connectionInput(role,"label").value.trim(),
      host:connectionInput(role,"host").value.trim()
    };
  }
  const enabled=Object.entries(routes).filter(([,route])=>route.enabled);
  if(!enabled.length){summary.textContent="Nothing was changed: at least one connection must remain enabled.";return}
  if(enabled.some(([,route])=>!route.host)){summary.textContent="Nothing was changed: every enabled connection needs a host or address.";return}
  const description=Object.entries(routes).map(([role,route])=>(role==="primary"?"Primary":"Fallback")+": "+(route.enabled?"enabled":"disabled")+" · "+route.label+" · "+(route.host||"no stored host")).join("\\n");
  if(!window.confirm("Save these HawkSpan connection settings?\\n\\n"+description+"\\n\\n"+(enabled.length===2?"Automatic fallback will be enabled.":"Only one connection will be used.")))return;
  button.disabled=true;summary.textContent="Validating and saving connection settings…";
  try{
    const data=await configCall("update_connection_configuration",{routes,confirm:true});
    showConnectionConfiguration(data);
    summary.textContent+=" Restart HawkSpan to activate these settings.";
  }catch(error){summary.textContent="Connection settings were not changed: "+String(error.message||error)}
  finally{button.disabled=false}
}
function safeText(value){return String(value??"").replace(/[&<>"']/g,character=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]))}
function selectedProfile(){return configurationProfiles.find(profile=>profile.id===document.querySelector("#profile-select").value)}
function showProfilePreview(){
  const profile=selectedProfile();
  const preview=document.querySelector("#profile-preview");
  document.querySelector("#apply-profile").disabled=!profile;
  document.querySelector("#delete-profile").disabled=!profile||profile.read_only;
  if(!profile){
    preview.innerHTML="<strong>Select a profile</strong><p>Its purpose and effect will appear here before you apply it.</p>";
    return;
  }
  preview.innerHTML="<strong>"+safeText(profile.name)+(profile.read_only?'<span class="profile-badge">Built in</span>':'<span class="profile-badge">Saved here</span>')+"</strong><p>"+safeText(profile.description)+"</p><p><strong>Effect:</strong> "+safeText(profile.impact)+"</p>";
}
async function loadProfiles(preferredId=""){
  const select=document.querySelector("#profile-select");
  const prior=preferredId||select.value;
  if(!profileManagementEnabled){
    select.innerHTML='<option value="">Profile tools not enabled</option>';
    select.disabled=true;
    document.querySelector("#profile-name").disabled=true;
    document.querySelector("#save-profile").disabled=true;
    document.querySelector("#reset-config").disabled=true;
    document.querySelector("#profile-preview").innerHTML="<strong>Profile management needs an allowlist update.</strong><p>Add the five configuration-profile tools documented in docs/LOCAL-CONTROL.md, then restart HawkSpan.</p>";
    return;
  }
  try{
    const data=await configCall("list_configuration_profiles");
    configurationProfiles=Array.isArray(data.profiles)?data.profiles:[];
    select.innerHTML='<option value="">Choose a profile…</option>'+configurationProfiles.map(profile=>'<option value="'+safeText(profile.id)+'">'+safeText(profile.name)+(profile.read_only?" · built in":" · saved")+"</option>").join("");
    if(configurationProfiles.some(profile=>profile.id===prior))select.value=prior;
    showProfilePreview();
  }catch(error){
    select.innerHTML='<option value="">Profiles unavailable</option>';
    document.querySelector("#profile-preview").innerHTML="<strong>Profiles could not be loaded.</strong><p>"+safeText(error.message||error)+"</p>";
  }
}
async function applySelectedProfile(){
  const profile=selectedProfile();
  if(!profile)return;
  if(!window.confirm('Apply “'+profile.name+'”?\\n\\n'+profile.impact+'\\n\\nPeer addresses, SSH identity, paths, plugins, and local-control settings will be preserved.'))return;
  const state=document.querySelector("#config-state");
  try{
    const data=await configCall("apply_configuration_profile",{profile_id:profile.id,confirm:true});
    showConfiguration(data.configuration);
    state.textContent="Applied “"+profile.name+"”. Restart HawkSpan to activate these settings.";
  }catch(error){state.textContent="Profile was not applied: "+String(error.message||error)}
}
async function saveNamedProfile(){
  const input=document.querySelector("#profile-name");
  const name=input.value.trim();
  const state=document.querySelector("#config-state");
  if(!name){state.textContent="Enter a name for the profile first.";input.focus();return}
  const existing=configurationProfiles.find(profile=>!profile.read_only&&profile.name.toLocaleLowerCase()===name.toLocaleLowerCase());
  if(existing&&!window.confirm('Replace the saved profile “'+existing.name+'” with the current active settings?'))return;
  try{
    const data=await configCall("save_configuration_profile",{name,confirm_replace:Boolean(existing)});
    input.value="";
    await loadProfiles(data.profile.id);
    state.textContent=(data.replaced?"Replaced":"Saved")+" profile “"+data.profile.name+"”.";
  }catch(error){state.textContent="Profile was not saved: "+String(error.message||error)}
}
async function deleteSelectedProfile(){
  const profile=selectedProfile();
  if(!profile||profile.read_only)return;
  if(!window.confirm('Delete the saved profile “'+profile.name+'”?\\n\\nThis will not change the active HawkSpan configuration.'))return;
  const state=document.querySelector("#config-state");
  try{
    await configCall("delete_configuration_profile",{profile_id:profile.id,confirm:true});
    await loadProfiles();
    state.textContent="Deleted profile “"+profile.name+"”. The active configuration was not changed.";
  }catch(error){state.textContent="Profile was not deleted: "+String(error.message||error)}
}
async function resetConfiguration(){
  if(!window.confirm("Reset HawkSpan’s role and feature flags to inherited symmetric defaults?\\n\\nPeer addresses, SSH identity, paths, plugins, and local-control settings will be preserved."))return;
  const state=document.querySelector("#config-state");
  try{
    const data=await configCall("reset_configuration",{confirm:true});
    showConfiguration(data);
    state.textContent="Flags were reset to inherited symmetric defaults. Restart HawkSpan to activate them.";
  }catch(error){state.textContent="Configuration was not reset: "+String(error.message||error)}
}
function selectedApplicationPreset(){return applicationPresets.find(preset=>preset.id===document.querySelector("#application-preset-select").value)}
async function showApplicationPresetPreview(){
  const preset=selectedApplicationPreset();
  const preview=document.querySelector("#application-preset-preview");
  document.querySelector("#apply-application-preset").disabled=!preset;
  document.querySelector("#reset-application-preset").disabled=!preset;
  if(!preset){preview.innerHTML="<strong>Select an application quick start</strong><p>Its purpose, restrictions, and preserved settings will appear here before you apply it.</p>";return}
  try{
    const data=await configCall("preview_application_preset",{preset_id:preset.id});
    preview.innerHTML="<strong>"+safeText(preset.name)+'<span class="profile-badge">'+safeText(preset.plugin_name)+"</span></strong><p>"+safeText(preset.description)+"</p><p><strong>Effect:</strong> "+safeText(preset.impact)+"</p><p><strong>Enabled operations:</strong> "+safeText(data.changes.enabled_operations.join(", ")||"none")+"</p><p><strong>Always preserved:</strong> connections, credentials, paths, tokens, local control, local plugin configuration, other plugins, and application data.</p>";
  }catch(error){preview.innerHTML="<strong>Preview unavailable.</strong><p>"+safeText(error.message||error)+"</p>"}
}
async function loadApplicationPresets(){
  const select=document.querySelector("#application-preset-select");
  if(!applicationPresetManagementEnabled){
    select.innerHTML='<option value="">Quick-start tools not enabled</option>';select.disabled=true;
    document.querySelector("#application-preset-preview").innerHTML="<strong>Application quick starts need an allowlist update.</strong><p>Add the four application-preset tools documented in docs/LOCAL-CONTROL.md, then restart HawkSpan.</p>";return;
  }
  try{
    const data=await configCall("list_application_presets");
    applicationPresets=Array.isArray(data.presets)?data.presets:[];
    select.innerHTML='<option value="">Choose an application quick start…</option>'+applicationPresets.map(preset=>'<option value="'+safeText(preset.id)+'">'+safeText(preset.plugin_name)+" · "+safeText(preset.name)+"</option>").join("");
    if(!applicationPresets.length)document.querySelector("#application-preset-preview").innerHTML="<strong>No application quick starts are installed.</strong><p>Install a reviewed, publicly releasable plugin that declares presets. Installation values and application data remain local.</p>";
    else await showApplicationPresetPreview();
  }catch(error){select.innerHTML='<option value="">Quick starts unavailable</option>';document.querySelector("#application-preset-preview").innerHTML="<strong>Application quick starts could not be loaded.</strong><p>"+safeText(error.message||error)+"</p>"}
}
async function applySelectedApplicationPreset(){
  const preset=selectedApplicationPreset();if(!preset)return;
  if(!window.confirm('Apply “'+preset.name+'” for '+preset.plugin_name+'?\n\n'+preset.impact+'\n\nConnections, credentials, paths, tokens, local-control settings, local plugin configuration, other plugins, and application data will be preserved.'))return;
  const state=document.querySelector("#config-state");
  try{const data=await configCall("apply_application_preset",{preset_id:preset.id,confirm:true});showConfiguration(data.configuration);state.textContent="Applied application quick start “"+preset.name+"”. Restart HawkSpan to activate it."}
  catch(error){state.textContent="Application quick start was not applied: "+String(error.message||error)}
}
async function resetSelectedApplicationPreset(){
  const preset=selectedApplicationPreset();if(!preset)return;
  if(!window.confirm('Reset “'+preset.name+'” to inherited defaults?\n\nThis removes role and capability overrides plus the operation restriction for '+preset.plugin_name+'. Connections, credentials, paths, tokens, local-control settings, local plugin configuration, other plugins, and application data will be preserved.'))return;
  const state=document.querySelector("#config-state");
  try{const data=await configCall("reset_application_preset",{preset_id:preset.id,confirm:true});showConfiguration(data.configuration);state.textContent="Reset application quick start “"+preset.name+"”. Restart HawkSpan to activate inherited defaults."}
  catch(error){state.textContent="Application quick start was not reset: "+String(error.message||error)}
}
async function saveConfiguration(){
  const state=document.querySelector("#config-state");
  const button=document.querySelector("#save-config");
  button.disabled=true;state.textContent="Validating and saving configuration…";
  const selectedFeatures={
    allowed_peer_tools:{
      inbound:toolsValue(document.querySelector('[data-tools="inbound"]').value),
      outbound:toolsValue(document.querySelector('[data-tools="outbound"]').value)
    },
    artifact_verification_mode:document.querySelector('[data-config="artifact_verification_mode"]').value,
    wake_prompt_mode:document.querySelector('[data-config="wake_prompt_mode"]').value
  };
  directionalFlags.forEach(([key])=>{selectedFeatures[key]={inbound:document.querySelector('[data-direction="'+key+'"][data-side="inbound"]').checked,outbound:document.querySelector('[data-direction="'+key+'"][data-side="outbound"]').checked}});
  booleanFlags.forEach(([key])=>{selectedFeatures[key]=document.querySelector('[data-boolean="'+key+'"]').checked});
  try{
    const roleProfile=document.querySelector('[data-config="role_profile"]').value;
    const nodeRole=document.querySelector('[data-config="node_role"]').value;
    if(roleProfile==="controller-worker"&&!nodeRole)throw new Error("Choose whether this Mac is the controller or worker.");
    const features=Object.fromEntries(Object.entries(selectedFeatures).filter(([key,value])=>
      JSON.stringify(value)!==JSON.stringify(loadedConfiguration?.features?.[key])
    ));
    const data=await configCall("update_configuration",{role_profile:roleProfile,node_role:roleProfile==="controller-worker"?nodeRole:null,features});
    showConfiguration(data);
    state.textContent=data.restart_required?"Saved. Restart HawkSpan to apply these changes.":"Configuration saved.";
  }catch(error){state.textContent="Nothing was changed: "+String(error.message||error)}
  finally{button.disabled=false}
}
document.querySelector("#reload-config").addEventListener("click",loadConfiguration);
document.querySelector("#save-config").addEventListener("click",saveConfiguration);
document.querySelector("#save-connections").addEventListener("click",saveConnectionConfiguration);
document.querySelector("#profile-select").addEventListener("change",showProfilePreview);
document.querySelector("#apply-profile").addEventListener("click",applySelectedProfile);
document.querySelector("#save-profile").addEventListener("click",saveNamedProfile);
document.querySelector("#delete-profile").addEventListener("click",deleteSelectedProfile);
document.querySelector("#reset-config").addEventListener("click",resetConfiguration);
document.querySelector("#application-preset-select").addEventListener("change",showApplicationPresetPreview);
document.querySelector("#apply-application-preset").addEventListener("click",applySelectedApplicationPreset);
document.querySelector("#reset-application-preset").addEventListener("click",resetSelectedApplicationPreset);
loadConfiguration();loadProfiles();loadConnectionConfiguration();loadApplicationPresets();
document.querySelector("#call").addEventListener("click",async()=>{
  const output=document.querySelector("#output");
  const human=document.querySelector("#human-result");
  const state=document.querySelector("#state");
  const button=document.querySelector("#call");
  button.disabled=true;state.textContent="Running…";output.textContent="Contacting HawkSpan…";human.innerHTML="<h3>Checking…</h3><p>HawkSpan is preparing a plain-language explanation.</p>";
  try{
    const body={tool_name:document.querySelector("#tool").value,
      arguments:JSON.parse(document.querySelector("#arguments").value)};
    const response=await fetch("/api/call",{method:"POST",
      headers:{"content-type":"application/json","x-hawkspan-token":token},
      body:JSON.stringify(body)});
    const data=await response.json();
    output.textContent=JSON.stringify(data,null,2);
    human.innerHTML=response.ok?explain(body.tool_name,data):'<h3>This check needs attention.</h3><p>'+String(data.error||"HawkSpan could not complete the request.")+'</p>';
    state.textContent=response.ok?"Complete":"Needs attention";
  }catch(error){output.textContent=String(error);human.innerHTML="<h3>This check could not be completed.</h3><p>Review the technical result for details.</p>";state.textContent="Error"}
  finally{button.disabled=false}
});
</script>`;
}

export async function startLocalControlSurface(configuration, callTool) {
  if (!configuration?.enabled) return null;
  if (configuration.host && configuration.host !== "127.0.0.1") {
    throw new Error("local_control.host must be 127.0.0.1");
  }
  if (configuration.allowed_tools &&
      (!Array.isArray(configuration.allowed_tools) ||
       configuration.allowed_tools.some((name) => typeof name !== "string"))) {
    throw new Error("local_control.allowed_tools must be an array of tool names");
  }
  if (configuration.route_labels &&
      (typeof configuration.route_labels !== "object" ||
       ["primary", "fallback"].some((role) =>
         typeof configuration.route_labels[role] !== "string" ||
         !configuration.route_labels[role].trim()))) {
    throw new Error("local_control.route_labels must define nonempty primary and fallback strings");
  }
  const allowedTools = new Set(configuration.allowed_tools || [
    "get_configuration",
    "update_configuration",
    "get_connection_configuration",
    "update_connection_configuration",
    "reset_configuration",
    "list_configuration_profiles",
    "save_configuration_profile",
    "apply_configuration_profile",
    "delete_configuration_profile",
    "list_application_presets",
    "preview_application_preset",
    "apply_application_preset",
    "reset_application_preset",
    "link_status",
    "application_plugin_status",
    "application_plugin_cancel",
  ]);
  const port = Number(configuration.port || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("local_control.port must be an integer from 0 through 65535");
  }
  const token = crypto.randomBytes(32).toString("hex");
  const server = http.createServer((request, response) => {
    const host = String(request.headers.host || "").split(":")[0];
    if (!["127.0.0.1", "localhost"].includes(host)) {
      sendJson(response, 400, { error: "invalid Host header" });
      return;
    }
    if (["GET", "HEAD"].includes(request.method) && helpVideos.has(request.url)) {
      sendHelpVideo(request, response, helpVideos.get(request.url));
      return;
    }
    if (request.method === "GET" && request.url === "/") {
      const body = page(token, configuration);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      });
      response.end(body);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/call") {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    if (request.headers["x-hawkspan-token"] !== token) {
      sendJson(response, 403, { error: "invalid control token" });
      return;
    }
    if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
      sendJson(response, 415, { error: "application/json is required" });
      return;
    }
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) request.destroy();
    });
    request.on("end", async () => {
      try {
        const body = JSON.parse(raw);
        if (!allowedTools.has(body.tool_name)) throw new Error("tool is not enabled for local HTML");
        const result = await callTool(body.tool_name, body.arguments || {}, "html");
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, 400, { error: String(error?.message || error) });
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({
      host: "127.0.0.1",
      port,
      exclusive: true,
    }, resolve);
  });
  server.unref();
  const address = server.address();
  return {
    host: "127.0.0.1",
    port: address.port,
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
