-- 聊天室 D1（SQLite）表结构
-- 在 Cloudflare 控制台 D1 的 SQL 控制台里执行，或用 wrangler：
--   wrangler d1 execute chatroom --remote --file=./schema.sql
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT ''
);
-- 限流查询用：按 IP + 时间统计最近 1 分钟的发消息数。
-- 没有这个索引，限流查询会全表扫描，浪费 D1 读行数。
-- 注意：带索引的列写入时，每 INSERT 一行会多算 1 行写入（表 1 行 + 索引 1 行），
-- 免费档每天 10 万行写入，相当于每天最多约 5 万条消息，足够用。
CREATE INDEX IF NOT EXISTS idx_messages_ip_time ON messages(ip, created_at);
