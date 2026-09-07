import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrfToken, currentUser, revokeSession, validCsrf } from './auth';
import { importSubscriptions, subscribe } from './feeds';
import { parseOpml } from './feed-content';
import { md5, randomToken, sha256 } from './crypto';
import type { User } from './types';

export const READ_SQL = 'COALESCE(st.read, CASE WHEN i.id<=s.read_before THEN 1 ELSE 0 END)';
export const ITEM_JOIN = 'FROM items i JOIN subscriptions s ON s.feed_id=i.feed_id AND s.user_id=? LEFT JOIN item_states st ON st.item_id=i.id AND st.user_id=s.user_id';
export const reader = new Hono<{ Bindings: Env; Variables: { user: User } }>();
reader.use('*', bodyLimit({ maxSize: 600_000 }));
reader.use('*', async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'Sign in to continue.' }, 401);
  c.set('user', user);
  if (!['GET', 'HEAD'].includes(c.req.method) && !(await validCsrf(c, c.req.header('X-CSRF-Token')))) return c.json({ error: 'The form expired. Reload and try again.' }, 403);
  await next();
});
reader.get('/me', async c => c.json({ user: c.get('user'), csrf: await csrfToken(c) }));
reader.post('/logout', async c => { await revokeSession(c); return c.json({ ok: true }); });
reader.get('/client-credential', async c => {
  const value = await c.env.DB.prepare('SELECT ac.username, ac.created_at, ac.last_used_at FROM api_credentials ac JOIN users u ON u.id=ac.user_id AND u.username=ac.username WHERE ac.user_id=?').bind(c.get('user').sub).first();
  return c.json({ credential: value || null, endpoint: `${c.env.APP_URL}/fever/` });
});
reader.post('/client-credential', async c => {
  const username = c.get('user').username;
  if (!username) return c.json({ error: 'Sign out and sign in again to refresh your OIDC username.' }, 409);
  const password = randomToken(24);
  const protocolKey = md5(`${username}:${password}`);
  await c.env.DB.prepare('INSERT INTO api_credentials(user_id,key_hash,username,created_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET key_hash=excluded.key_hash,username=excluded.username,created_at=excluded.created_at,last_used_at=NULL')
    .bind(c.get('user').sub, await sha256(protocolKey), username, Math.floor(Date.now()/1000)).run();
  return c.json({ endpoint: `${c.env.APP_URL}/fever/`, username, password }, 201);
});
reader.delete('/client-credential', async c => {
  await c.env.DB.prepare('DELETE FROM api_credentials WHERE user_id=?').bind(c.get('user').sub).run();
  return c.json({ ok: true });
});
reader.get('/subscriptions', async c => {
  const rows = await c.env.DB.prepare(`SELECT f.id, f.url, COALESCE(s.custom_title, f.title) AS title, s.folder, f.error, f.last_success_at, f.next_fetch_at,
    (SELECT COUNT(*) FROM items i LEFT JOIN item_states st ON st.item_id=i.id AND st.user_id=s.user_id WHERE i.feed_id=f.id AND ${READ_SQL}=0) AS unread
    FROM subscriptions s JOIN feeds f ON f.id=s.feed_id WHERE s.user_id=? ORDER BY s.folder, title`).bind(c.get('user').sub).all();
  return c.json(rows.results);
});
reader.get('/feed-directory', async c => {
  const rows = await c.env.DB.prepare(`SELECT f.id,f.url,f.title,f.site_url,
    (SELECT COUNT(*) FROM subscriptions all_subs WHERE all_subs.feed_id=f.id) AS subscribers,
    (SELECT COUNT(*) FROM items i WHERE i.feed_id=f.id) AS items
    FROM feeds f WHERE NOT EXISTS(SELECT 1 FROM subscriptions own WHERE own.feed_id=f.id AND own.user_id=?)
    ORDER BY (f.last_success_at IS NULL) ASC,subscribers DESC,f.title LIMIT 200`).bind(c.get('user').sub).all();
  return c.json(rows.results);
});
reader.post('/subscriptions', async c => {
  const body = await c.req.json<{ url?: unknown; folder?: unknown }>();
  if (typeof body.url !== 'string' || body.url.length > 2048) return c.json({ error: 'Enter a feed or website URL.' }, 400);
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE user_id=?').bind(c.get('user').sub).first<{ n: number }>();
  if ((count?.n || 0) >= 500) return c.json({ error: 'The MVP supports up to 500 subscriptions per account.' }, 400);
  try { return c.json({ id: await subscribe(c.env, c.get('user').sub, body.url, typeof body.folder === 'string' ? body.folder : '') }, 201); }
  catch (error) {
    console.error(JSON.stringify({ event: 'subscription_failed', message: error instanceof Error ? error.message : 'unknown' }));
    return c.json({ error: 'Could not subscribe. Use a public RSS/Atom URL or a website with a feed link (maximum 5 MB, no private credentials).' }, 400);
  }
});
reader.post('/subscriptions/import', async c => {
  const body = await c.req.json<{ opml?: unknown }>();
  if (typeof body.opml !== 'string' || body.opml.length > 500_000) return c.json({ error: 'Choose an OPML file smaller than 500 KB.' }, 400);
  try { return c.json(await importSubscriptions(c.env, c.get('user').sub, parseOpml(body.opml)), 201); }
  catch (error) {
    console.error(JSON.stringify({ event: 'opml_import_failed', message: error instanceof Error ? error.message : 'unknown' }));
    return c.json({ error: error instanceof Error && /OPML|subscriptions/.test(error.message) ? error.message : 'Could not import this OPML file.' }, 400);
  }
});
reader.patch('/subscriptions/:id', async c => {
  const body = await c.req.json<{ title?: unknown; folder?: unknown }>();
  if (typeof body.folder !== 'string' || typeof body.title !== 'string') return c.json({ error: 'Title and folder must be text.' }, 400);
  await c.env.DB.prepare('UPDATE subscriptions SET custom_title=?, folder=? WHERE user_id=? AND feed_id=?').bind(body.title.slice(0,500) || null, body.folder.slice(0,100), c.get('user').sub, Number(c.req.param('id'))).run();
  return c.json({ ok: true });
});
reader.delete('/subscriptions/:id', async c => {
  await c.env.DB.prepare('DELETE FROM subscriptions WHERE user_id=? AND feed_id=?').bind(c.get('user').sub, Number(c.req.param('id'))).run();
  return c.json({ ok: true });
});
reader.get('/items', async c => {
  const filter = c.req.query('filter');
  const feed = Number(c.req.query('feed')) || 0;
  const beforeDate = Number(c.req.query('before_date')) || Number.MAX_SAFE_INTEGER;
  const beforeId = Number(c.req.query('before_id')) || Number.MAX_SAFE_INTEGER;
  const rows = await c.env.DB.prepare(`SELECT i.id, i.feed_id, i.title, i.url, i.author, i.published_at, ${READ_SQL} AS read, COALESCE(st.starred,0) AS starred, f.title AS feed_title
    ${ITEM_JOIN} JOIN feeds f ON f.id=i.feed_id WHERE (i.published_at<? OR (i.published_at=? AND i.id<?)) AND (?=0 OR i.feed_id=?) ${filter === 'unread' ? `AND ${READ_SQL}=0` : filter === 'starred' ? 'AND st.starred=1' : ''} ORDER BY i.published_at DESC,i.id DESC LIMIT 50`)
    .bind(c.get('user').sub, beforeDate, beforeDate, beforeId, feed, feed).all();
  return c.json(rows.results);
});
reader.get('/items/:id', async c => {
  const item = await c.env.DB.prepare(`SELECT i.*, ${READ_SQL} AS read, COALESCE(st.starred,0) AS starred ${ITEM_JOIN} WHERE i.id=?`).bind(c.get('user').sub, Number(c.req.param('id'))).first();
  return item ? c.json(item) : c.json({ error: 'Article not found.' }, 404);
});
export async function updateItem(env: Env, user: string, id: number, read: number | null, starred: number | null): Promise<boolean> {
  const result = await env.DB.prepare(`INSERT INTO item_states(user_id,item_id,read,starred,updated_at)
    SELECT ?, i.id, ?, COALESCE(?,0), unixepoch() FROM items i JOIN subscriptions s ON s.feed_id=i.feed_id AND s.user_id=? WHERE i.id=?
    ON CONFLICT(user_id,item_id) DO UPDATE SET read=COALESCE(?,item_states.read), starred=COALESCE(?,item_states.starred), updated_at=unixepoch()`)
    .bind(user, read, starred, user, id, read, starred).run();
  return result.meta.changes > 0;
}
reader.patch('/items/:id', async c => {
  const body = await c.req.json<{ read?: unknown; starred?: unknown }>();
  const read = typeof body.read === 'boolean' ? Number(body.read) : null;
  const starred = typeof body.starred === 'boolean' ? Number(body.starred) : null;
  if (read === null && starred === null) return c.json({ error: 'Choose read or starred state.' }, 400);
  const updated = await updateItem(c.env, c.get('user').sub, Number(c.req.param('id')), read, starred);
  return updated ? c.json({ ok: true }) : c.json({ error: 'Article not found.' }, 404);
});
reader.post('/mark-read', async c => {
  const body = await c.req.json<{ feed?: unknown }>();
  const feed = Number(body.feed) || 0;
  const user = c.get('user').sub;
  // Use ingestion IDs as a watermark, so future backdated articles still arrive unread.
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE subscriptions SET read_before=COALESCE((SELECT MAX(id) FROM items WHERE feed_id=subscriptions.feed_id),0) WHERE user_id=? AND (?=0 OR feed_id=?)').bind(user, feed, feed),
    c.env.DB.prepare('UPDATE item_states SET read=NULL WHERE user_id=? AND item_id IN (SELECT i.id FROM items i JOIN subscriptions s ON s.feed_id=i.feed_id AND s.user_id=? WHERE i.id<=s.read_before AND (?=0 OR i.feed_id=?))').bind(user,user,feed,feed),
  ]);
  return c.json({ ok: true });
});
