import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  calls: [] as { table: string; filters: [string, string][] }[],
  results: {} as Record<string, { data?: unknown; error: unknown }>,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: 'forbidden' }, { status: 403 })),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
}));

/** Minimal chain: from(t).delete().eq().eq()[.select()] → result of table t. */
function fakeDb() {
  return {
    from(table: string) {
      const call = { table, filters: [] as [string, string][] };
      mocks.calls.push(call);
      const result = () => Promise.resolve(mocks.results[table] ?? { data: [], error: null });
      const chain = {
        delete: () => chain,
        eq: (col: string, val: string) => {
          call.filters.push([col, val]);
          return chain;
        },
        select: () => result(),
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => result().then(ok, ko),
      };
      return chain;
    },
  };
}

import { DELETE } from './route';

const ID = '11111111-2222-4333-8444-555555555555';
const params = (id = ID) => ({ params: Promise.resolve({ id }) });
const req = () => new Request(`http://localhost/api/contacts/${ID}`, { method: 'DELETE' });

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.results = {};
  mocks.requireRole.mockReset();
  mocks.requireRole.mockResolvedValue({ supabase: fakeDb(), accountId: 'acc-1', userId: 'u-1', role: 'owner' });
});

describe('DELETE /api/contacts/[id]', () => {
  it('is owner only', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const res = await DELETE(req(), params());
    expect(res.status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('owner');
    expect(mocks.calls).toHaveLength(0);
  });

  it('deletes the pipeline cards first, then the contact, scoped to the account', async () => {
    mocks.results.contacts = { data: [{ id: ID }], error: null };
    const res = await DELETE(req(), params());
    expect(res.status).toBe(200);
    expect(mocks.calls.map((c) => c.table)).toEqual(['deals', 'contacts']);
    expect(mocks.calls[0].filters).toEqual([['contact_id', ID], ['account_id', 'acc-1']]);
    expect(mocks.calls[1].filters).toEqual([['id', ID], ['account_id', 'acc-1']]);
  });

  it('404 for a bad id or a contact of another account', async () => {
    expect((await DELETE(req(), params('nope'))).status).toBe(404);
    const res = await DELETE(req(), params());
    expect(res.status).toBe(404);
  });

  it('does not delete the contact if its cards could not be deleted', async () => {
    mocks.results.deals = { error: { message: 'boom' } };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await DELETE(req(), params());
    expect(res.status).toBe(500);
    expect(mocks.calls.map((c) => c.table)).toEqual(['deals']);
  });
});
