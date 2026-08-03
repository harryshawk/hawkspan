import fs from "node:fs";
import path from "node:path";

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;",
  })[character]);
}

export async function activate(context) {
  return {
    operations: {
      async render(args, run) {
        const output = path.join(context.stateDirectory, `${run.runId}.svg`);
        const title = escapeXml(args.title.trim());
        const subtitle = escapeXml(args.subtitle?.trim() || "Rendered by HawkSpan");
        const background = args.background || "#12345b";
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
<rect width="960" height="540" fill="${background}"/>
<text x="480" y="250" fill="#ffffff" font-family="system-ui" font-size="58" text-anchor="middle">${title}</text>
<text x="480" y="310" fill="#c9d8eb" font-family="system-ui" font-size="24" text-anchor="middle">${subtitle}</text>
</svg>
`;
        fs.writeFileSync(output, svg, { mode: 0o600 });
        const artifact = await context.callCoreTool("register_artifact", {
          path: output,
          name: "synthetic-render.svg",
          metadata: { plugin: "synthetic-render", operation: "render" },
        });
        return { rendered: true, format: "svg", output, artifact };
      },
    },
  };
}
