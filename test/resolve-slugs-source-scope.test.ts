/**
 * #2430 — resolve_slugs + get_brain_identity + whoami source-scope hardening.
 *
 * The `resolve_slugs` OP HANDLER dropped the caller's source scope: a scoped
 * MCP caller could fuzzy-resolve slugs belonging to OTHER sources, even though
 * `get_page` (which already threads scope) 404s the same slug. Slugs alone leak
 * client names / project topics. The engine method already honored scope
 * (#1436, covered by operations-fuzzy-source-scope.test.ts); the untested gap
 * was the op handler, which never passed sourceScopeOpts(ctx). This test drives
 * the op registry directly (same pattern as get-page-federated-scope.test.ts).
 *
 * Also covers:
 *  - get_brain_identity banner counts are scope-filtered (were global → leaked
 *    the aggregate size of other sources to any read client).
 *  - whoami returns {transport:'local'} over the stdio-local pipe (localTransport)
 *    instead of throwing unknown_transport, while the fail-closed throw is
 *    preserved for a genuine remote-without-auth path.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const resolve_slugs = operations.find(o => o.name === 'resolve_slugs')!;
const get_brain_identity = operations.find(o => o.name === 'get_brain_identity')!;
const whoami = operations.find(o => o.name === 'whoami')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

function remoteCtx(allowedSources: string[]): OperationContext {
  return ctxOf({ remote: true, sourceId: undefined, auth: { token: 't', clientId: 'c', scopes: [], allowedSources } as any });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', '/tmp/beta') ON CONFLICT (id) DO NOTHING`);
  // A default-scope page and a beta-scope page under the same slug prefix, so a
  // fuzzy resolve of "clients/" would surface the beta slug if scope leaked.
  await engine.putPage('clients/default-co', {
    type: 'note', title: 'Default Co', compiled_truth: 'default content', frontmatter: {},
  }, { sourceId: 'default' });
  await engine.putPage('clients/beta-secret-co', {
    type: 'note', title: 'Beta Secret Co', compiled_truth: 'beta content', frontmatter: {},
  }, { sourceId: 'beta' });
});

describe('resolve_slugs op honors the caller source scope', () => {
  test('default-scoped caller does NOT resolve a beta-only slug (the leak)', async () => {
    const slugs = (await resolve_slugs.handler(ctxOf({ sourceId: 'default' }), { partial: 'clients/' })) as string[];
    expect(slugs).toContain('clients/default-co');
    expect(slugs).not.toContain('clients/beta-secret-co');
  });

  test('beta-scoped caller resolves its own slug, not the default one', async () => {
    const slugs = (await resolve_slugs.handler(ctxOf({ sourceId: 'beta' }), { partial: 'clients/' })) as string[];
    expect(slugs).toContain('clients/beta-secret-co');
    expect(slugs).not.toContain('clients/default-co');
  });

  test('exact-match path is scoped too (no cross-source confirm/deny)', async () => {
    const asDefault = (await resolve_slugs.handler(ctxOf({ sourceId: 'default' }), { partial: 'clients/beta-secret-co' })) as string[];
    expect(asDefault).toEqual([]);
    const asBeta = (await resolve_slugs.handler(ctxOf({ sourceId: 'beta' }), { partial: 'clients/beta-secret-co' })) as string[];
    expect(asBeta).toEqual(['clients/beta-secret-co']);
  });

  test('federated grant [beta] resolves beta slugs; [default] excludes them', async () => {
    const granted = (await resolve_slugs.handler(remoteCtx(['beta']), { partial: 'clients/' })) as string[];
    expect(granted).toContain('clients/beta-secret-co');
    expect(granted).not.toContain('clients/default-co');
    const ungranted = (await resolve_slugs.handler(remoteCtx(['default']), { partial: 'clients/' })) as string[];
    expect(ungranted).not.toContain('clients/beta-secret-co');
  });
});

describe('get_brain_identity counts are source-scoped', () => {
  test('default-scoped caller sees only its own page count, not the global total', async () => {
    const id = (await get_brain_identity.handler(ctxOf({ sourceId: 'default' }), {})) as { page_count: number; chunk_count: number };
    // Only clients/default-co is in the default scope; beta's page must not count.
    expect(id.page_count).toBe(1);
    const betaId = (await get_brain_identity.handler(ctxOf({ sourceId: 'beta' }), {})) as { page_count: number };
    expect(betaId.page_count).toBe(1);
  });
});

describe('whoami transport shape', () => {
  test('stdio-local pipe (localTransport, no auth) returns local, not unknown_transport', async () => {
    const res = (await whoami.handler(ctxOf({ remote: true, localTransport: true, auth: undefined }), {})) as { transport: string; scopes: string[] };
    expect(res.transport).toBe('local');
    expect(res.scopes).toEqual([]);
  });

  test('genuine remote without auth (no localTransport) still throws unknown_transport', async () => {
    await expect(whoami.handler(ctxOf({ remote: true, localTransport: undefined, auth: undefined }), {}))
      .rejects.toBeInstanceOf(OperationError);
  });
});
