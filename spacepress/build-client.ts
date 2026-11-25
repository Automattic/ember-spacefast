import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "../spacefast/node_modules/esbuild/lib/main.js";

const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));
execFileSync("npm", ["run", "build:styles"], { cwd: fromHere("../spacefast/"), stdio: "inherit" });

const assets = fromHere("./public/assets/");

await mkdir(assets, { recursive: true });
await cp(fromHere("../spacefast/service-worker.js"), fromHere("./public/service-worker.js"));
const icon = await readFile(fromHere("../spacefast/assets/ember-icon-192.png"));
await writeFile(fromHere("./public/favicon.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><image width="192" height="192" href="data:image/png;base64,' +
  icon.toString("base64") + '"/></svg>');
await cp(fromHere("../spacefast/assets/"), assets, {
  recursive: true,
  filter: name => !/ember-app\.[a-f0-9]+\.js$/.test(name),
});

await build({
  entryPoints: [fromHere("./client/browser.ts")],
  outfile: assets + "spacepress-ember.js",
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2023"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  nodePaths: [fromHere("../spacefast/node_modules/")],
  legalComments: "eof",
  plugins: [{
    name: "spacepress-sdk",
    setup(build) {
      build.onResolve({ filter: /(^|\/)native-sdk$/ }, () => ({ path: fromHere("./client/sdk.ts") }));
    },
  }],
});
