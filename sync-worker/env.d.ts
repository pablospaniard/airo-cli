// Wrangler cannot infer deployed secret names from wrangler.jsonc because
// secrets must not be committed there. Keep this augmentation beside the
// generated binding types and update it with `wrangler secret put` changes.
declare global {
  namespace Cloudflare {
    interface Env {
      GITHUB_CLIENT_SECRET: string;
    }
  }

  interface Env {
    GITHUB_CLIENT_SECRET: string;
  }
}

export {};
