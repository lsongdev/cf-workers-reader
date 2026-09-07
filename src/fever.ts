import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { now, sha256 } from './crypto';
import { ITEM_JOIN, READ_SQL, updateItem } from './reader';

type Output = Record<string, unknown>;
export const fever = new Hono<{ Bindings: Env }>();
fever.use('*', bodyLimit({ maxSize: 8192 }));
fever.post('*', async c => {
  const form = await c.req.formData();
  const query = new URL(c.req.url).searchParams;
  if (!query.has('api')) return c.json({ api_version: 3, auth: 0 });
  const apiKey = form.get('api_key');
  const base: Output = { api_version: 3, auth: 0 };
  if (typeof apiKey !== 'string' || !/^[a-f\d]{32}$/i.test(apiKey)) return c.json(base);
  const credential = await c.env.DB.prepare('SELECT ac.user_id FROM api_credentials ac JOIN users u ON u.id=ac.user_id AND u.username=ac.username WHERE ac.key_hash=?').bind(await sha256(apiKey.toLowerCase())).first<{ user_id: string }>();
  if (!credential) return c.json(base);
  const user = credential.user_id;
  await c.env.DB.prepare('UPDATE api_credentials SET last_used_at=? WHERE user_id=?').bind(now(), user).run();
  const refreshed = await c.env.DB.prepare('SELECT COALESCE(MAX(f.last_fetched_at),0) AS value FROM subscriptions s JOIN feeds f ON f.id=s.feed_id WHERE s.user_id=?').bind(user).first<{ value: number }>();
  Object.assign(base, { auth: 1, last_refreshed_on_time: refreshed?.value || 0 });
  try {
    if (query.has('groups')) Object.assign(base, await groups(c.env, user));
    if (query.has('feeds')) Object.assign(base, await feeds(c.env, user));
    if (query.has('favicons')) base.favicons = [];
    if (query.has('items')) Object.assign(base, await items(c.env, user, query));
    if (query.has('unread_item_ids')) base.unread_item_ids = await stateIds(c.env, user, false);
    if (query.has('saved_item_ids')) base.saved_item_ids = await stateIds(c.env, user, true);
    if (query.has('links')) base.links = [];
    if (form.get('unread_recently_read') === '1') {
      await c.env.DB.prepare('UPDATE item_states SET read=0,updated_at=? WHERE user_id=? AND read=1 AND item_id IN (SELECT item_id FROM item_states WHERE user_id=? AND read=1 ORDER BY updated_at DESC LIMIT 50)').bind(now(),user,user).run();
      base.unread_item_ids = await stateIds(c.env,user,false);
    }
    const mark = form.get('mark'), as = form.get('as'), id = Number(form.get('id')), before = Number(form.get('before')) || now();
    if (typeof mark === 'string' && typeof as === 'string') {
      if (mark === 'item' && Number.isSafeInteger(id) && id > 0 && ['read','unread','saved','unsaved'].includes(as)) {
        await updateItem(c.env,user,id,as === 'read' ? 1 : as === 'unread' ? 0 : null,as === 'saved' ? 1 : as === 'unsaved' ? 0 : null);
        base[as === 'saved' || as === 'unsaved' ? 'saved_item_ids' : 'unread_item_ids'] = await stateIds(c.env,user,as === 'saved' || as === 'unsaved');
      } else if ((mark === 'feed' || mark === 'group') && as === 'read' && Number.isSafeInteger(id)) {
        await markCollection(c.env,user,mark,id,before);
        base.unread_item_ids = await stateIds(c.env,user,false);
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ event: 'fever_request_error', message: error instanceof Error ? error.message : 'unknown' }));
  }
  return c.json(base);
});

async function ensureGroups(env: Env,user: string): Promise<void> {
  await env.DB.prepare("INSERT INTO groups(user_id,title) SELECT DISTINCT user_id,folder FROM subscriptions WHERE user_id=? AND folder<>'' ON CONFLICT(user_id,title) DO NOTHING").bind(user).run();
}
async function groups(env: Env,user: string): Promise<Output> {
  await ensureGroups(env,user);
  const values = await env.DB.prepare('SELECT id,title FROM groups WHERE user_id=? ORDER BY title').bind(user).all();
  return { groups: values.results, feeds_groups: await relationships(env,user) };
}
async function feeds(env: Env,user: string): Promise<Output> {
  await ensureGroups(env,user);
  const values = await env.DB.prepare('SELECT f.id,f.id AS favicon_id,COALESCE(s.custom_title,f.title) AS title,f.url,COALESCE(f.site_url,\'\') AS site_url,0 AS is_spark,COALESCE(f.last_success_at,0) AS last_updated_on_time FROM subscriptions s JOIN feeds f ON f.id=s.feed_id WHERE s.user_id=? ORDER BY f.id').bind(user).all();
  return { feeds: values.results, feeds_groups: await relationships(env,user) };
}
async function relationships(env: Env,user: string): Promise<Array<{group_id:number;feed_ids:string}>> {
  const values = await env.DB.prepare("SELECT g.id AS group_id,GROUP_CONCAT(s.feed_id) AS feed_ids FROM groups g JOIN subscriptions s ON s.user_id=g.user_id AND s.folder=g.title WHERE g.user_id=? GROUP BY g.id ORDER BY g.id").bind(user).all<{ group_id:number;feed_ids:string }>();
  return values.results;
}
async function items(env: Env,user: string,query: URLSearchParams): Promise<Output> {
  let condition = '', args: unknown[] = [user];
  const withIds = (query.get('with_ids') || '').split(',').map(Number).filter(id => Number.isSafeInteger(id) && id>0).slice(0,50);
  if (withIds.length) { condition=`AND i.id IN (${withIds.map(()=>'?').join(',')})`; args.push(...withIds); }
  else if (query.has('since_id')) { condition='AND i.id>?'; args.push(Math.max(0,Number(query.get('since_id'))||0)); }
  else { const max=Math.max(0,Number(query.get('max_id'))||0); condition='AND (?=0 OR i.id<?)'; args.push(max,max); }
  const direction = query.has('since_id') && !withIds.length ? 'ASC' : 'DESC';
  const values = await env.DB.prepare(`SELECT i.id,i.feed_id,i.title,i.author,i.content AS html,i.url,COALESCE(st.starred,0) AS is_saved,${READ_SQL} AS is_read,i.published_at AS created_on_time ${ITEM_JOIN} WHERE 1=1 ${condition} ORDER BY i.id ${direction} LIMIT 50`).bind(...args).all();
  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM items i JOIN subscriptions s ON s.feed_id=i.feed_id WHERE s.user_id=?').bind(user).first<{n:number}>();
  return { items: values.results, total_items: total?.n || 0 };
}
async function stateIds(env: Env,user: string,saved: boolean): Promise<string> {
  const condition = saved ? 'COALESCE(st.starred,0)=1' : `${READ_SQL}=0`;
  const values = await env.DB.prepare(`SELECT GROUP_CONCAT(i.id) AS ids ${ITEM_JOIN} WHERE ${condition}`).bind(user).first<{ids:string|null}>();
  return values?.ids || '';
}
async function markCollection(env: Env,user:string,type:string,id:number,before:number): Promise<void> {
  let filter=''; const args: unknown[]=[user,before];
  if(type==='feed'){filter='AND i.feed_id=?';args.push(id);}
  else if(id>0){filter='AND s.folder=(SELECT title FROM groups WHERE id=? AND user_id=?)';args.push(id,user);}
  else if(id===-1){filter='AND 0';}
  await env.DB.prepare(`INSERT INTO item_states(user_id,item_id,read,starred,updated_at) SELECT ?,i.id,1,COALESCE(st.starred,0),unixepoch() FROM items i JOIN subscriptions s ON s.feed_id=i.feed_id AND s.user_id=? LEFT JOIN item_states st ON st.user_id=s.user_id AND st.item_id=i.id WHERE i.published_at<=? ${filter} ON CONFLICT(user_id,item_id) DO UPDATE SET read=1,updated_at=unixepoch()`)
    .bind(user,...args).run();
}
