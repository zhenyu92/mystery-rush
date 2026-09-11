/**
 * Test-only module hooks.
 *
 * The worker is written for the Cloudflare runtime, so two things it takes
 * for granted are not true under `node --test`:
 *
 *   - `cloudflare:workers` is a built-in there and does not exist here, so it
 *     is redirected to a minimal stand-in for `DurableObject`;
 *   - imports are extensionless (`./game`) and `mysteries.json` is imported
 *     without an import attribute, both of which the bundler resolves and
 *     Node does not.
 *
 * Everything else - TypeScript itself included, via Node's built-in type
 * stripping - needs no help, which is why there is no build step and no test
 * dependency to keep in sync with the one that ships.
 */
import { registerHooks } from 'node:module';

const WORKERS_STUB = new URL('./cloudflare-workers.mjs', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') {
      return { url: WORKERS_STUB, shortCircuit: true };
    }

    let resolved;
    try {
      resolved = nextResolve(specifier, context);
    } catch (err) {
      // `./game` -> `./game.ts`, the way the bundler resolves it.
      if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw err;
    }

    // The bundler imports JSON without `with { type: 'json' }`; Node insists.
    if (resolved.url.endsWith('.json')) {
      return { ...resolved, importAttributes: { type: 'json' } };
    }
    return resolved;
  },
});
