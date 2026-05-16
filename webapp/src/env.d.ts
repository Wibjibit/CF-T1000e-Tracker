/// <reference path="../.astro/types.d.ts" />
/// <reference path="../worker-configuration.d.ts" />

// The global Env interface and Cloudflare.Env namespace are auto-generated
// by `wrangler types` based on bindings + secrets in wrangler.jsonc and
// .dev.vars.example. Re-run `wrangler types` after editing wrangler.jsonc.

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}
