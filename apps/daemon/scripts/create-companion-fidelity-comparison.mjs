import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VIEWPORTS = ["desktop", "mobile"];

function page(title, body, extraCss = "") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: #181818; color: #f5f5f5; font: 14px/1.4 system-ui, sans-serif; }
    header { position: sticky; top: 0; z-index: 2; padding: 10px 16px; background: #111; border-bottom: 1px solid #444; }
    main { padding: 16px; }
    img { display: block; max-width: 100%; height: auto; }
    .side-by-side { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
    figure { margin: 0; min-width: 0; }
    figcaption { margin-bottom: 8px; color: #ccc; }
    .overlay { position: relative; width: max-content; max-width: 100%; }
    .overlay img + img { position: absolute; inset: 0; opacity: .5; }
    ${extraCss}
  </style>
</head>
<body>
  <header>${title}</header>
  <main>${body}</main>
</body>
</html>
`;
}

export function createCompanionFidelityComparison(directory) {
  const dir = resolve(directory);
  const outputs = [];
  for (const viewport of VIEWPORTS) {
    const implementation = `${viewport}-implementation.png`;
    const reference = `${viewport}-reference.png`;
    for (const image of [implementation, reference]) {
      if (!existsSync(join(dir, image))) throw new Error(`missing comparison input: ${image}`);
    }
    const snapshots = new Map([
      [implementation, readFileSync(join(dir, implementation))],
      [reference, readFileSync(join(dir, reference))],
    ]);
    const sideBySide = join(dir, `${viewport}-side-by-side.html`);
    const overlay = join(dir, `${viewport}-overlay.html`);
    writeFileSync(sideBySide, page(
      `${viewport} side-by-side`,
      `<div class="side-by-side">
  <figure><figcaption>Implementation</figcaption><img src="${implementation}" alt="Implementation"></figure>
  <figure><figcaption>Reference</figcaption><img src="${reference}" alt="Reference"></figure>
</div>`,
    ));
    writeFileSync(overlay, page(
      `${viewport} 50% overlay`,
      `<div class="overlay"><img src="${implementation}" alt="Implementation"><img src="${reference}" alt="Reference at 50% opacity"></div>`,
    ));
    for (const [image, bytes] of snapshots) {
      if (!readFileSync(join(dir, image)).equals(bytes)) {
        throw new Error(`comparison generation modified input image: ${image}`);
      }
    }
    outputs.push(sideBySide, overlay);
  }
  return outputs;
}

export function comparisonOutputBasenames(outputs) {
  return outputs.map((file) => basename(file));
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--dir" || !argv[1]) {
    throw new Error("usage: node scripts/create-companion-fidelity-comparison.mjs --dir <capture-directory>");
  }
  return resolve(argv[1]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const outputs = createCompanionFidelityComparison(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ ok: true, outputs: comparisonOutputBasenames(outputs) }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
