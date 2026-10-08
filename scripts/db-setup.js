/* eslint-disable */
// Creates / updates the Orbit tables in MySQL or MariaDB by reading prisma/schema.prisma.
// It does not need Prisma's migration engine (nothing is downloaded). It is idempotent.
const fs = require('fs');
const path = require('path');
const mariadb = require('mariadb');

function parseSchema(text) {
  const models = [];
  const lines = text.split(/\r?\n/);
  let cur = null;
  for (let raw of lines) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    let m = line.match(/^model\s+(\w+)\s*\{$/);
    if (m) { cur = { name: m[1], fields: [], ids: null, uniques: [], indexes: [] }; continue; }
    if (!cur) continue;
    if (line === '}') { models.push(cur); cur = null; continue; }
    if (!line) continue;
    if (line.startsWith('@@')) {
      const b = line.match(/^@@(id|unique|index)\(\[(.*?)\]/);
      if (b) {
        const cols = b[2].split(',').map((c) => {
          const t = c.trim();
          return { name: t.replace(/\(.*$/, ''), desc: /sort:\s*Desc/i.test(t) };
        });
        if (b[1] === 'id') cur.ids = cols.map((c) => c.name);
        else if (b[1] === 'unique') cur.uniques.push(cols);
        else cur.indexes.push(cols);
      }
      continue;
    }
    const f = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/);
    if (!f) continue;
    cur.fields.push({ name: f[1], type: f[2], list: !!f[3], optional: !!f[4], attrs: f[5] || '' });
  }
  return models;
}

function qid(s) { return '`' + s.replace(/`/g, '``') + '`'; }

function build(models, isMaria) {
  const names = new Set(models.map((m) => m.name));
  const byName = Object.fromEntries(models.map((m) => [m.name, m]));
  const tables = [];
  const fks = [];
  for (const m of models) {
    const idCols = new Set(m.ids || []);
    const keepVarchar = new Set();
    m.fields.forEach((f) => { if (/@id\b/.test(f.attrs)) idCols.add(f.name); });
    [...m.uniques, ...m.indexes].forEach((g) => g.forEach((c) => keepVarchar.add(c.name)));
    (m.ids || []).forEach((c) => keepVarchar.add(c));
    m.fields.forEach((f) => {
      if (/@unique\b/.test(f.attrs) || /@id\b/.test(f.attrs)) keepVarchar.add(f.name);
      const rel = f.attrs.match(/@relation\((.*)\)/);
      if (rel && names.has(f.type)) {
        const fl = rel[1].match(/fields:\s*\[(.*?)\]/);
        const rf = rel[1].match(/references:\s*\[(.*?)\]/);
        if (fl && rf) {
          const cols = fl[1].split(',').map((x) => x.trim());
          const refs = rf[1].split(',').map((x) => x.trim());
          cols.forEach((c) => keepVarchar.add(c));
          const od = (rel[1].match(/onDelete:\s*(\w+)/) || [])[1];
          const ou = (rel[1].match(/onUpdate:\s*(\w+)/) || [])[1];
          const optional = cols.every((c) => (m.fields.find((x) => x.name === c) || {}).optional);
          const map = { Cascade: 'CASCADE', Restrict: 'RESTRICT', SetNull: 'SET NULL', NoAction: 'NO ACTION', SetDefault: 'SET DEFAULT' };
          fks.push({
            table: m.name, name: `${m.name}_${cols.join('_')}_fkey`, cols, ref: f.type, refs,
            onDelete: map[od] || (optional ? 'SET NULL' : 'RESTRICT'), onUpdate: map[ou] || 'CASCADE',
          });
        }
      }
    });
    // fields referenced from other tables must also be VARCHAR
    models.forEach((o) => o.fields.forEach((f) => {
      const rel = f.attrs.match(/@relation\((.*)\)/);
      if (rel && f.type === m.name) {
        const rf = rel[1].match(/references:\s*\[(.*?)\]/);
        if (rf) rf[1].split(',').forEach((c) => keepVarchar.add(c.trim()));
      }
    }));

    const cols = [];
    for (const f of m.fields) {
      if (names.has(f.type)) continue; // relation, not a column
      let type;
      const db = f.attrs.match(/@db\.(\w+)(?:\((\d+)\))?/);
      if (db && db[1] === 'Char') type = `CHAR(${db[2] || 36})`;
      else if (db && db[1] === 'Text') type = 'TEXT';
      else {
        switch (f.type) {
          case 'Int': type = 'INT'; break;
          case 'BigInt': type = 'BIGINT'; break;
          case 'Boolean': type = 'TINYINT(1)'; break;
          case 'DateTime': type = 'DATETIME(3)'; break;
          case 'Float': type = 'DOUBLE'; break;
          case 'Decimal': type = 'DECIMAL(65,30)'; break;
          case 'Json': type = 'JSON'; break;
          case 'String': type = 'VARCHAR(191)'; break;
          default: throw new Error('Unsupported type: ' + f.type + ' in ' + m.name + '.' + f.name);
        }
      }
      let def = '';
      const auto = /@default\(autoincrement\(\)\)/.test(f.attrs);
      const d = f.attrs.match(/@default\((.*?)\)(?:\s|$)/);
      if (auto) def = ' AUTO_INCREMENT';
      else if (/@default\(now\(\)\)/.test(f.attrs)) def = ' DEFAULT CURRENT_TIMESTAMP(3)';
      else if (f.type === 'Json' && /@default\("\[\]"\)/.test(f.attrs)) def = isMaria ? " DEFAULT '[]'" : ' DEFAULT (JSON_ARRAY())';
      else if (d && !/uuid\(|cuid\(/.test(d[1])) {
        const v = d[1];
        if (v === 'true') def = ' DEFAULT 1';
        else if (v === 'false') def = ' DEFAULT 0';
        else if (/^-?\d+(\.\d+)?$/.test(v)) def = ' DEFAULT ' + v;
        else if (/^"(.*)"$/.test(v)) def = " DEFAULT '" + v.slice(1, -1).replace(/'/g, "''") + "'";
      }
      cols.push({ name: f.name, sql: `${qid(f.name)} ${type} ${f.optional ? 'NULL' : 'NOT NULL'}${def}`, def: def });
      f._col = true;
    }
    const pk = m.ids ? m.ids : m.fields.filter((f) => /@id\b/.test(f.attrs)).map((f) => f.name);
    const keys = [];
    if (pk.length) keys.push(`PRIMARY KEY (${pk.map(qid).join(', ')})`);
    const seen = new Set();
    const uniq = [...m.uniques];
    m.fields.forEach((f) => { if (/@unique\b/.test(f.attrs) && !/@id\b/.test(f.attrs)) uniq.push([{ name: f.name }]); });
    uniq.forEach((g) => {
      const n = `${m.name}_${g.map((c) => c.name).join('_')}_key`;
      if (seen.has(n)) return; seen.add(n);
      keys.push(`UNIQUE KEY ${qid(n)} (${g.map((c) => qid(c.name)).join(', ')})`);
    });
    m.indexes.forEach((g) => {
      const n = `${m.name}_${g.map((c) => c.name).join('_')}_idx`;
      keys.push(`KEY ${qid(n)} (${g.map((c) => qid(c.name) + (c.desc ? ' DESC' : '')).join(', ')})`);
    });
    tables.push({ name: m.name, cols, sql: `CREATE TABLE IF NOT EXISTS ${qid(m.name)} (\n  ${[...cols.map((c) => c.sql), ...keys].join(',\n  ')}\n) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci` });
  }
  return { tables, fks };
}

async function main() {
  const url = new URL(process.env.DATABASE_URL.replace(/^jdbc:/, ''));
  const conn = await mariadb.createConnection({
    host: url.hostname, port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''), connectTimeout: 20000, bigIntAsNumber: true,
  });
  try {
    const ver = String((await conn.query('SELECT VERSION() AS v'))[0].v);
    const isMaria = /mariadb/i.test(ver);
    console.log(`[DB] Connected to ${isMaria ? 'MariaDB' : 'MySQL'} ${ver}`);
    const models = parseSchema(fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8'));
    const { tables, fks } = build(models, isMaria);

    const existing = new Set((await conn.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()')).map((r) => r.t));
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    let created = 0, altered = 0;
    for (const t of tables) {
      if (!existing.has(t.name)) { await conn.query(t.sql); created++; continue; }
      const have = new Set((await conn.query('SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t.name])).map((r) => r.c));
      for (const c of t.cols) {
        if (!have.has(c.name)) {
          // new column on an existing table: added as NULL when there is no default value
          const sql = c.def ? c.sql : c.sql.replace(' NOT NULL', ' NULL');
          await conn.query(`ALTER TABLE ${qid(t.name)} ADD COLUMN ${sql}`); altered++;
        }
      }
    }
    const haveFk = new Set((await conn.query("SELECT CONSTRAINT_NAME AS n FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'FOREIGN KEY'")).map((r) => r.n));
    let fkAdded = 0;
    for (const f of fks) {
      if (haveFk.has(f.name)) continue;
      await conn.query(`ALTER TABLE ${qid(f.table)} ADD CONSTRAINT ${qid(f.name)} FOREIGN KEY (${f.cols.map(qid).join(', ')}) REFERENCES ${qid(f.ref)} (${f.refs.map(qid).join(', ')}) ON DELETE ${f.onDelete} ON UPDATE ${f.onUpdate}`);
      fkAdded++;
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log(`[DB] Done: ${created} tables created, ${altered} columns added, ${fkAdded} foreign keys created (${tables.length} tables in total).`);
  } finally {
    await conn.end();
  }
}

module.exports = { main, parseSchema, build };
if (require.main === module) {
  main().catch((e) => { console.error('[DB] Error:', e.message); process.exit(1); });
}
