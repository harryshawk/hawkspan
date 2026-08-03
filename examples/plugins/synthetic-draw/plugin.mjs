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
      async draw(args, run) {
        const output = path.join(context.stateDirectory, `${run.runId}.svg`);
        const shape = args.shape === "circle"
          ? `<circle cx="320" cy="210" r="125" fill="${args.color}"/>`
          : `<rect x="195" y="85" width="250" height="250" rx="18" fill="${args.color}"/>`;
        const label = escapeXml(args.label?.trim() || `Synthetic ${args.shape}`);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">
<rect width="640" height="420" fill="#f4f7fb"/>
${shape}
<text x="320" y="385" fill="#182028" font-family="system-ui" font-size="24" text-anchor="middle">${label}</text>
</svg>
`;
        fs.writeFileSync(output, svg, { mode: 0o600 });
        const artifact = await context.callCoreTool("register_artifact", {
          path: output,
          name: "synthetic-draw.svg",
          metadata: { plugin: "synthetic-draw", operation: "draw" },
        });
        return { drawn: true, format: "svg", shape: args.shape, output, artifact };
      },
    },
  };
}
