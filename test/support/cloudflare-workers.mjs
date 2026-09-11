/**
 * Stand-in for the `cloudflare:workers` built-in module.
 *
 * The real `DurableObject` base class does exactly this much that matters to
 * EventRoom: it stashes `ctx` and `env` on the instance.
 */
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
