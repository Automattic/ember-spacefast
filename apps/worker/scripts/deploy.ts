// Deploys the Worker with the secrets it doesn't have yet, so a new deployment works without anyone
// making them. Deploy to Cloudflare's build runs it as `pnpm run deploy`, and the Preview workflow
// runs it with its own options, which go on to `wrangler deploy`:
//
//   node apps/worker/scripts/deploy.ts [--name <worker>] [--config <file>] [--var NAME:value ...]
//
// Sessions are stored keyed with SESSION_SECRET, so changing it would sign everyone out: the first
// deploy makes one and later ones keep it. Browsers subscribe to push notifications with
// VAPID_PUBLIC_KEY, so the first deploy makes a VAPID key pair too, and later ones keep it. Whoever
// deployed, and nobody else, sets Ember up (apps/worker/src/setup.ts) with its setup password,
// EMBER_SETUP_PASSWORD, which Deploy to Cloudflare's form asks them to make up, or which the deploy's
// environment gives. A Worker with neither that nor a setup token gets EMBER_SETUP_TOKEN, the one secret
// meant to be read: the deploy prints the setup link that carries it, which is spent once Ember is set
// up. The secrets go up with the code in one `wrangler deploy --secrets-file`, from a file only this
// deploy can read, and nothing else here prints them: Cloudflare's build logs mask nothing, as GitHub's
// would. A CI log can be public, as a public repository's Actions logs are, so there the deploy makes no
// setup token, and says so, unless EMBER_SETUP_TOKEN in its environment brings one the deployer keeps as
// a secret of their own. Workers Builds' log is the account's own, so it can carry the link. The keys of
// a Memberful custom app, for its members to sign in (apps/worker/src/memberful.ts), and of a Turnstile
// widget, for open sign-up's check, in place of any given in Set up Turnstile (apps/worker/src/turnstile.ts),
// go up with every deploy whose environment gives them, as the Preview workflow's does from the
// repository's secrets. Deploy to Cloudflare's copy of Ember leaves out the .github folder, and with
// it the Update Ember workflow that offers the copy Ember's releases, so a deploy without that workflow
// ends by saying how to add it.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vapidKeys } from "./vapid-keys.ts";

/** The repository's root, where wrangler.jsonc is. */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Ember's repository, where its releases come from. */
const EMBER = "https://github.com/NYLLON-SOFTWARE/ember-cloudflare";
/** The workflow that offers a copy Ember's releases (docs/self-hosting.md#updating), and Ember's, kept beside this script. */
const UPDATE_WORKFLOW = ".github/workflows/update-ember.yml";
const EMBERS_UPDATE_WORKFLOW = new URL("./update-ember.yml", import.meta.url);

/** Runs `pnpm exec wrangler` from the root, with its output captured or shown, and `env` besides this process's. */
function wrangler(args: string[], capture: boolean, env: Record<string, string> = {}) {
  return spawnSync("pnpm", ["exec", "wrangler", ...args], { cwd: ROOT, encoding: "utf8", stdio: capture ? "pipe" : "inherit", env: { ...process.env, ...env } });
}

/** The wrangler options that pick which Worker a command acts on, besides the ones wrangler.jsonc names. */
const TARGET_OPTIONS = ["--name", "--config", "-c"];

/** Whether `arg` is `option`, alone or with its value after `=`. */
const isOption = (arg: string, option: string) => arg === option || arg.startsWith(`${option}=`);

/**
 * The options among wrangler deploy's that pick its Worker, so `wrangler secret list` looks at the
 * same one. wrangler.jsonc has no environments, and an environment's Worker name depends on how it's
 * combined with `--name`, so `--env` is refused rather than guessed at.
 */
function targetOptions(args: string[]): string[] {
  if (args.some((arg) => isOption(arg, "--env") || isOption(arg, "-e"))) {
    throw new Error("wrangler.jsonc has no environments, so the deploy takes no --env.");
  }
  return args.flatMap((arg, at) => {
    if (TARGET_OPTIONS.includes(arg)) return args.slice(at, at + 2);
    return TARGET_OPTIONS.some((option) => isOption(arg, option)) ? [arg] : [];
  });
}

/**
 * The names of the Worker's secrets, or none when there's no Worker yet. Failing to list them for
 * any other reason throws, rather than replacing ones that may be there.
 */
function secretNames(target: string[]): string[] {
  const listed = wrangler(["secret", "list", ...target], true);
  if (listed.status === 0) return (JSON.parse(listed.stdout) as { name: string }[]).map(({ name }) => name);
  if (/Worker "[^"]+" not found/.test(listed.stdout + listed.stderr)) return [];
  throw new Error(`Couldn't list the Worker's secrets:\n${listed.stdout}${listed.stderr}`);
}

/** The shape of EMBER_SETUP_TOKEN, as the Worker checks it (apps/worker/src/secrets.ts): `openssl rand -hex 32`. */
const SETUP_TOKEN = /^[0-9a-f]{64}$/;

/** Whether this deploy's output may be public: a CI log, except Workers Builds', which is the account's own. */
const inPublicLog = () => !!process.env.CI && !process.env.WORKERS_CI;

/**
 * The keys of a Memberful custom app, and the secret its site signs webhooks with, then a Turnstile
 * widget's, and a Resend API key, which only the deployer can give.
 */
const GIVEN_KEYS = [
  "MEMBERFUL_URL",
  "MEMBERFUL_CLIENT_ID",
  "MEMBERFUL_CLIENT_SECRET",
  "MEMBERFUL_API_KEY",
  "MEMBERFUL_WEBHOOK_SECRET",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "RESEND_API_KEY",
];

/**
 * The keys the deploy's environment gives, which go up with every deploy, so a key changed where the
 * deployer keeps it changes in the Worker too. Ones it doesn't give stay as the Worker has them.
 */
function givenSecrets(): Record<string, string> {
  return Object.fromEntries(GIVEN_KEYS.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])));
}

/** What the deploy says it uploads: the secrets it made, and the ones its environment gave, by name alone. */
function uploading(made: string[], given: string[]): string {
  const secrets = [made.length ? `new ${made.join(", ")}` : "", given.length ? `${given.join(", ")} from the environment` : ""].filter(Boolean);
  return secrets.length ? `Deploying with ${secrets.join(", and ")}` : "Deploying with the Worker's secrets as they are";
}

/**
 * What became of the Worker's setup token: made here, given by the environment, withheld from a public
 * log, or kept from before, or not needed, as the Worker has a setup password, which a first deploy says
 * how to use ("password"), and a later one doesn't ("kept").
 */
type SetupToken = "made" | "given" | "withheld" | "kept" | "password";

/** New values for the secrets a Worker that has `names` is missing, and what became of its setup token. */
async function missingSecrets(names: string[]): Promise<{ secrets: Record<string, string>; setupToken: SetupToken }> {
  const secrets: Record<string, string> = {};
  if (!names.includes("SESSION_SECRET")) secrets.SESSION_SECRET = randomBytes(32).toString("hex");
  // A Worker with only one of the pair keeps it, and says in /api/health why push is off.
  if (!names.includes("VAPID_PUBLIC_KEY") && !names.includes("VAPID_PRIVATE_KEY")) {
    const { publicKey, privateKey } = await vapidKeys();
    Object.assign(secrets, { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey });
  }
  let setupToken: SetupToken = "kept";
  const password = process.env.EMBER_SETUP_PASSWORD?.trim();
  if (names.includes("EMBER_SETUP_PASSWORD")) {
    // As Deploy to Cloudflare's form gives it. The first deploy makes SESSION_SECRET too; by a later
    // one, Ember may well be set up.
    if (!names.includes("SESSION_SECRET")) setupToken = "password";
  } else if (password) {
    [secrets.EMBER_SETUP_PASSWORD, setupToken] = [password, "password"];
  } else if (!names.includes("EMBER_SETUP_TOKEN")) {
    const given = process.env.EMBER_SETUP_TOKEN?.trim();
    if (given) {
      if (!SETUP_TOKEN.test(given)) throw new Error("EMBER_SETUP_TOKEN must be 64 lowercase hex characters, as `openssl rand -hex 32` makes.");
      [secrets.EMBER_SETUP_TOKEN, setupToken] = [given, "given"];
    } else if (inPublicLog()) {
      setupToken = "withheld";
    } else {
      [secrets.EMBER_SETUP_TOKEN, setupToken] = [randomBytes(32).toString("hex"), "made"];
    }
  }
  return { secrets, setupToken };
}

/**
 * The https origin a target of the deploy names, or null for one that names none. wrangler records
 * the workers.dev address as a URL, routes and custom domains as their patterns with notes after a
 * space (`chat.example.com (custom domain)`, `example.com/* (zone name: example.com)`), and queues,
 * workflows and the like in words (`Producer for jobs`). A route under a path, or with a wildcard
 * host, isn't an address Ember can be opened at.
 */
function originOf(target: string): string | null {
  if (URL.canParse(target)) {
    const url = new URL(target);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  }
  const host = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/\*)?(?: |$)/i.exec(target)?.[1];
  return host === undefined ? null : `https://${host}`;
}

/**
 * The Worker's address, from wrangler's record of this deploy in `outputFile`, or null where it recorded
 * none it can be opened at. wrangler appends a record to the file for each deploy, so a file the environment
 * keeps may hold earlier deploys' records, maybe other Workers', before this one's: the last record is this deploy's.
 */
function deployedUrl(outputFile: string): string | null {
  if (!existsSync(outputFile)) return null;
  const records = readFileSync(outputFile, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { type?: string; targets?: string[] }];
      } catch {
        return [];
      }
    });
  const origins = (records.findLast((record) => record.type === "deploy")?.targets ?? []).flatMap((target) => originOf(target) ?? []);
  return origins.find((origin) => origin.endsWith(".workers.dev")) ?? origins[0] ?? null;
}

/**
 * Says how to set Ember up at `url`, with its setup password or link, as what became of the Worker's setup
 * token allows, naming the Worker as the deploy's `target` options do, so a new password or token goes to
 * the Worker deployed, not wrangler.jsonc's.
 */
function tellSetupLink(setupToken: SetupToken, token: string | undefined, url: string | null, target: string[]): void {
  const setup = `${url ?? "https://<your Worker>"}/first_run`;
  const page = `${setup}#token=`;
  // `wrangler secret put` asks for the value, so the person sees the token they make, which a pipe would hide.
  const newToken = `make one with openssl rand -hex 32, give it to the Worker with ${["pnpm exec wrangler secret put EMBER_SETUP_TOKEN", ...target].join(" ")}, which asks for it, and open ${page}<the token>`;
  const putPassword = `${["pnpm exec wrangler secret put EMBER_SETUP_PASSWORD", ...target].join(" ")}, which asks for it`;
  if (setupToken === "password") {
    console.log(
      `\nSet up Ember at ${setup} with its setup password, EMBER_SETUP_PASSWORD. If it's forgotten, give it a new one in the Cloudflare dashboard, in the Worker's Settings under Variables and Secrets, or with ${putPassword}.`,
    );
  } else if (setupToken === "made") {
    console.log(`\nSet up Ember at ${page}${token}\nThat link carries this deployment's setup token, printed only now, and is spent once Ember is set up. If it's lost, ${newToken}`);
  } else if (setupToken === "given") {
    console.log(`\nSet up Ember at ${page}<your EMBER_SETUP_TOKEN>`);
  } else if (setupToken === "withheld") {
    const notice = `Nobody can set Ember up until the Worker has a setup password or an EMBER_SETUP_TOKEN secret, and this log may be public, so this deploy made no token. Give it a setup password with ${putPassword}, and open ${setup}; or set EMBER_SETUP_TOKEN in the deploy's environment from a secret of your own (openssl rand -hex 32) and deploy again, then open ${page}<your EMBER_SETUP_TOKEN>; or ${newToken}`;
    console.log(process.env.GITHUB_ACTIONS === "true" ? `::notice::${notice}` : `\n${notice}`);
  }
}

/**
 * The GitHub repository the checkout came from, as `owner/name`, or null where git's origin isn't one
 * on github.com. A build's origin may carry its clone's credentials, which go no further than this.
 */
function githubRepository(): string | null {
  const origin = spawnSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" });
  if (origin.status !== 0) return null;
  return /^(?:https:\/\/(?:[^@/]*@)?github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(origin.stdout.trim())?.[1] ?? null;
}

/**
 * Says how to add the Update Ember workflow to a copy that has none, as Deploy to Cloudflare's don't:
 * on GitHub, with a link that opens the copy's editor with Ember's workflow in it, ready to commit, on a
 * line of its own to copy, as the whole workflow makes it long.
 */
function tellUpdateWorkflow(): void {
  if (existsSync(path.join(ROOT, UPDATE_WORKFLOW))) return;
  const repository = githubRepository();
  const missing = "\nThis copy of Ember has no Update Ember workflow, which Deploy to Cloudflare leaves out with the rest of the .github folder, so nothing offers it Ember's new releases.";
  if (repository && `https://github.com/${repository}`.toLowerCase() !== EMBER.toLowerCase() && existsSync(EMBERS_UPDATE_WORKFLOW)) {
    // A branch's name may hold what a link can't, such as `#`, so each of its parts goes in encoded.
    const branch = (process.env.WORKERS_CI_BRANCH || "main").split("/").map(encodeURIComponent).join("/");
    const editor = `https://github.com/${repository}/new/${branch}`;
    const workflow = new URLSearchParams({ filename: UPDATE_WORKFLOW, value: readFileSync(EMBERS_UPDATE_WORKFLOW, "utf8") });
    console.log(`${missing} To have each come as a pull request, commit the workflow in GitHub's editor, which this link opens with it filled in:\n${editor}?${workflow}`);
  } else {
    console.log(
      `${missing} On GitHub, add ${UPDATE_WORKFLOW} to it as Ember has it, ${EMBER}/blob/main/${UPDATE_WORKFLOW}, to have each come as a pull request; elsewhere, update it with apps/worker/scripts/update-ember.ts (docs/self-hosting.md#updating).`,
    );
  }
}

/** Deploys with `args` and the missing secrets, says how to set Ember up, and answers wrangler's exit status. */
async function deploy(args: string[]): Promise<number> {
  const target = targetOptions(args);
  const { secrets, setupToken } = await missingSecrets(secretNames(target));
  const given = givenSecrets();
  const dir = mkdtempSync(path.join(tmpdir(), "ember-deploy-"));
  try {
    const file = path.join(dir, "secrets.json");
    writeFileSync(file, JSON.stringify({ ...secrets, ...given }), { mode: 0o600 });
    console.log(uploading(Object.keys(secrets), Object.keys(given)));
    // wrangler records what it deployed, the Worker's address among it, in the file the environment names, else one of this deploy's own.
    const output = process.env.WRANGLER_OUTPUT_FILE_PATH || path.join(dir, "wrangler-output.json");
    const status = wrangler(["deploy", "--secrets-file", file, ...args], false, { WRANGLER_OUTPUT_FILE_PATH: output }).status ?? 1;
    if (status === 0) {
      tellSetupLink(setupToken, secrets.EMBER_SETUP_TOKEN, deployedUrl(output), target);
      tellUpdateWorkflow();
    }
    return status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await deploy(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
