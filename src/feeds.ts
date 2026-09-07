import { now, randomToken } from './crypto';
import { boundedText, discoverFeed, fetchPublic, parseFeed, publicFeedUrl, type OpmlSubscription, type ParsedFeed } from './feed-content';

export type FeedQueueMessage = { type: 'feed'; id: number; token: string };
export type SchedulerQueueMessage = { type: 'schedule'; token: string; sequence: number };
export type ReaderQueueMessage = FeedQueueMessage | SchedulerQueueMessage;

export interface Feed { id: number; url: string; title: string; site_url: string | null; etag: string | null; last_modified: string | null; fetch_interval: number; next_fetch_at: number; last_fetched_at: number | null; last_success_at: number | null; error_count: number; error: string | null; lease_token: string | null; fetching_until: number }

async function storeItems(env: Env, id: number, parsed: ParsedFeed): Promise<number> {
  let added = 0;
  for (let offset = 0; offset < parsed.items.length; offset += 40) {
    const results = await env.DB.batch(parsed.items.slice(offset, offset + 40).map(item =>
      env.DB.prepare('INSERT INTO items(feed_id, guid, url, title, content, author, published_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(feed_id, guid) DO UPDATE SET url=excluded.url,title=excluded.title,content=excluded.content,author=excluded.author,published_at=excluded.published_at WHERE items.url<>excluded.url OR items.title<>excluded.title OR items.content<>excluded.content OR items.author<>excluded.author OR items.published_at<>excluded.published_at')
        .bind(id, item.guid, item.url, item.title, item.content, item.author, item.published_at)));
    added += results.reduce((sum, r) => sum + r.meta.changes, 0);
  }
  return added;
}

export async function subscribe(env: Env, user: string, value: string, folder = ''): Promise<number> {
  const submitted = publicFeedUrl(value.trim());
  let found = await env.DB.prepare('SELECT feed_id AS id FROM feed_aliases WHERE url=?').bind(submitted).first<{ id: number }>();
  if (!found) {
    const discovered = await discoverFeed(submitted);
    const created = await env.DB.prepare('INSERT INTO feeds(url, title, site_url) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET url=excluded.url RETURNING id').bind(discovered.url, discovered.parsed.title, discovered.parsed.site_url).first<{ id: number }>();
    if (!created) throw new Error('Could not create feed.');
    found = created;
    await env.DB.batch([...new Set(discovered.aliases)].map(url => env.DB.prepare('INSERT INTO feed_aliases(url, feed_id) VALUES (?, ?) ON CONFLICT(url) DO NOTHING').bind(url, found!.id)));
    await storeItems(env, found.id, discovered.parsed);
    await env.DB.prepare('UPDATE feeds SET etag=?, last_modified=?, last_fetched_at=?, last_success_at=?, next_fetch_at=? WHERE id=? AND last_fetched_at IS NULL')
      .bind(discovered.response.headers.get('etag'), discovered.response.headers.get('last-modified'), now(), now(), now() + 1800, found.id).run();
  }
  await env.DB.prepare('INSERT INTO subscriptions(user_id, feed_id, folder) VALUES (?, ?, ?) ON CONFLICT(user_id, feed_id) DO NOTHING').bind(user, found.id, folder.slice(0, 100)).run();
  return found.id;
}

export async function importSubscriptions(env: Env, user: string, entries: OpmlSubscription[]): Promise<{ imported: number; updated: number; skipped: number; failed: number; queued: number }> {
  const current = await env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE user_id=?').bind(user).first<{ n: number }>();
  let available = Math.max(0, 500 - (current?.n || 0));
  let imported = 0, updated = 0, skipped = 0, failed = 0;
  const queued: FeedQueueMessage[] = [];
  const queuedIds = new Set<number>();
  for (const entry of entries) {
    try {
      const submitted = publicFeedUrl(entry.url.trim());
      let feed = await env.DB.prepare('SELECT f.id,f.last_fetched_at FROM feed_aliases a JOIN feeds f ON f.id=a.feed_id WHERE a.url=?').bind(submitted).first<{ id: number; last_fetched_at: number | null }>();
      if (!feed) {
        if (!available) { skipped++; continue; }
        feed = await env.DB.prepare('INSERT INTO feeds(url,title,site_url) VALUES (?,?,NULL) ON CONFLICT(url) DO UPDATE SET url=excluded.url RETURNING id,last_fetched_at')
          .bind(submitted, entry.title || new URL(submitted).hostname).first<{ id: number; last_fetched_at: number | null }>();
        if (!feed) throw new Error('Could not create feed.');
        await env.DB.prepare('INSERT INTO feed_aliases(url,feed_id) VALUES (?,?) ON CONFLICT(url) DO NOTHING').bind(submitted, feed.id).run();
      }
      const existing = await env.DB.prepare('SELECT feed_id FROM subscriptions WHERE user_id=? AND feed_id=?').bind(user, feed.id).first();
      if (existing) {
        await env.DB.prepare('UPDATE subscriptions SET folder=?,custom_title=? WHERE user_id=? AND feed_id=?').bind(entry.folder.slice(0, 100), entry.title || null, user, feed.id).run();
        updated++;
        continue;
      }
      if (!available) { skipped++; continue; }
      const added = await env.DB.prepare('INSERT INTO subscriptions(user_id,feed_id,folder,custom_title) VALUES (?,?,?,?) ON CONFLICT(user_id,feed_id) DO NOTHING RETURNING feed_id')
        .bind(user, feed.id, entry.folder.slice(0, 100), entry.title || null).first();
      if (!added) { skipped++; continue; }
      imported++; available--;
      if (feed.last_fetched_at === null && !queuedIds.has(feed.id)) {
        const token = randomToken();
        const claimed = await env.DB.prepare('UPDATE feeds SET queue_token=?,queued_at=? WHERE id=? AND queued_at<? RETURNING id').bind(token, now(), feed.id, now() - 600).first();
        if (claimed) { queued.push({ type: 'feed', id: feed.id, token }); queuedIds.add(feed.id); }
      }
    } catch { failed++; }
  }
  try {
    for (let offset = 0; offset < queued.length; offset += 100) await env.FETCH_QUEUE.sendBatch(queued.slice(offset, offset + 100).map(body => ({ body })));
  } catch (error) {
    if (queued.length) await env.DB.batch(queued.map(message => env.DB.prepare('UPDATE feeds SET queue_token=NULL,queued_at=0 WHERE id=? AND queue_token=?').bind(message.id, message.token)));
    throw error;
  }
  return { imported, updated, skipped, failed, queued: queued.length };
}

export function nextInterval(interval: number, added: number): number {
  return Math.round(Math.max(300, Math.min(43200, interval * (added ? 0.7 : 1.5))));
}

export async function refreshFeed(env: Env, id: number, queuedToken = ""): Promise<void> {
  const token = randomToken();
  const feed = await env.DB.prepare("UPDATE feeds SET lease_token=?, fetching_until=? WHERE id=? AND fetching_until<? AND ((?='' AND next_fetch_at<=?) OR queue_token=?) AND EXISTS(SELECT 1 FROM subscriptions WHERE feed_id=feeds.id) RETURNING *")
    .bind(token, now() + 300, id, now(), queuedToken, now(), queuedToken).first<Feed>();
  if (!feed) return;
  try {
    const headers: Record<string, string> = {};
    if (feed.etag) headers['If-None-Match'] = feed.etag;
    if (feed.last_modified) headers['If-Modified-Since'] = feed.last_modified;
    const fetched = await fetchPublic(feed.url, headers);
    let added = 0;
    if (fetched.response.status !== 304) {
      if (!fetched.response.ok) {
        await fetched.response.body?.cancel();
        throw new Error(`HTTP ${fetched.response.status}`);
      }
      const parsed = await parseFeed(await boundedText(fetched.response), fetched.url);
      added = await storeItems(env, id, parsed);
      await env.DB.prepare('UPDATE feeds SET title=?, site_url=?, etag=?, last_modified=? WHERE id=? AND lease_token=?')
        .bind(parsed.title, parsed.site_url, fetched.response.headers.get('etag'), fetched.response.headers.get('last-modified'), id, token).run();
      await env.DB.batch(fetched.aliases.map(url => env.DB.prepare('INSERT INTO feed_aliases(url, feed_id) VALUES (?, ?) ON CONFLICT(url) DO NOTHING').bind(url, id)));
    }
    const interval = nextInterval(feed.fetch_interval, added);
    await env.DB.prepare('UPDATE feeds SET fetch_interval=?, next_fetch_at=?, last_fetched_at=?, last_success_at=?, error_count=0, error=NULL, fetching_until=0, lease_token=NULL, queue_token=NULL, queued_at=0 WHERE id=? AND lease_token=?')
      .bind(interval, now() + interval, now(), now(), id, token).run();
  } catch (error) {
    const delay = Math.min(86400, 1800 * 2 ** Math.min(feed.error_count, 6));
    // Never persist raw URLs or upstream response bodies in public error messages.
    const message = error instanceof Error && /^HTTP \d{3}$/.test(error.message) ? error.message : 'Feed could not be fetched or parsed.';
    await env.DB.prepare('UPDATE feeds SET next_fetch_at=?, last_fetched_at=?, error_count=error_count+1, error=?, fetching_until=0, lease_token=NULL, queue_token=NULL, queued_at=0 WHERE id=? AND lease_token=?')
      .bind(now() + delay, now(), message, id, token).run();
  }
}

export async function scheduleFeeds(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now()),
    env.DB.prepare('DELETE FROM oidc_transactions WHERE expires_at<=?').bind(now()),
  ]);
  const due = await env.DB.prepare('SELECT id FROM feeds WHERE next_fetch_at<=? AND fetching_until<? AND queued_at<? AND EXISTS(SELECT 1 FROM subscriptions WHERE feed_id=feeds.id) ORDER BY next_fetch_at LIMIT 100').bind(now(), now(), now() - 600).all<{ id: number }>();
  const messages: Array<{ body: FeedQueueMessage }> = [];
  for (const feed of due.results) {
    const token = randomToken();
    const claimed = await env.DB.prepare('UPDATE feeds SET queue_token=?, queued_at=? WHERE id=? AND queued_at<? RETURNING id').bind(token, now(), feed.id, now() - 600).first();
    if (claimed) messages.push({ body: { type: 'feed', id: feed.id, token } });
  }
  if (messages.length) await env.FETCH_QUEUE.sendBatch(messages);
}

/**
 * Start a scheduler generation when the previous Queue heartbeat has been
 * silent for 15 minutes. The D1 claim makes this safe to call from every
 * health check without creating parallel heartbeat chains.
 */
export async function ensureScheduler(env: Env): Promise<boolean> {
  const timestamp = now();
  const token = randomToken();
  const claimed = await env.DB.prepare(
    'UPDATE scheduler_state SET token=?, sequence=0, last_seen_at=?, lease_until=0 WHERE id=1 AND (token IS NULL OR last_seen_at<?) RETURNING id',
  ).bind(token, timestamp, timestamp - 900).first();
  if (!claimed) return false;
  try {
    await env.FETCH_QUEUE.send({ type: 'schedule', token, sequence: 0 } satisfies SchedulerQueueMessage);
    return true;
  } catch (error) {
    await env.DB.prepare('UPDATE scheduler_state SET token=NULL, last_seen_at=0, lease_until=0 WHERE id=1 AND token=?').bind(token).run();
    throw error;
  }
}

/** Process one heartbeat exactly once, then enqueue its successor. */
export async function runSchedulerHeartbeat(env: Env, message: SchedulerQueueMessage): Promise<void> {
  const timestamp = now();
  const claimed = await env.DB.prepare(
    'UPDATE scheduler_state SET lease_until=?, last_seen_at=? WHERE id=1 AND token=? AND sequence=? AND lease_until<? RETURNING id',
  ).bind(timestamp + 900, timestamp, message.token, message.sequence, timestamp).first();
  if (!claimed) return;
  try {
    await scheduleFeeds(env);
    const next = message.sequence + 1;
    await env.FETCH_QUEUE.send(
      { type: 'schedule', token: message.token, sequence: next } satisfies SchedulerQueueMessage,
      { delaySeconds: 300 },
    );
    const advanced = await env.DB.prepare(
      'UPDATE scheduler_state SET sequence=?, last_seen_at=?, lease_until=0 WHERE id=1 AND token=? AND sequence=? RETURNING id',
    ).bind(next, now(), message.token, message.sequence).first();
    if (!advanced) throw new Error('Scheduler heartbeat state changed before it advanced.');
  } catch (error) {
    await env.DB.prepare('UPDATE scheduler_state SET lease_until=0 WHERE id=1 AND token=? AND sequence=?').bind(message.token, message.sequence).run();
    throw error;
  }
}
