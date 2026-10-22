const knex = require('knex');
const path = require('path');
const fs = require('fs');

const isPg = process.env.DB_CLIENT === 'pg';
const file = process.env.SQLITE_FILE || './data/simplimo.db';
if (!isPg) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

const db = knex(
  isPg
    ? { client: 'pg', connection: process.env.PG_URL, pool: { min: 0, max: 10 } }
    : { client: 'better-sqlite3', connection: { filename: file }, useNullAsDefault: true }
);

// Insertion renvoyant l'id, identique pour SQLite et PostgreSQL
async function ins(k, table, row) {
  const r = await k(table).insert(row).returning('id');
  return typeof r[0] === 'object' ? r[0].id : r[0];
}

async function init() {
  const make = async (name, fn) => { if (!(await db.schema.hasTable(name))) await db.schema.createTable(name, fn); };
  await make('users', t => {
    t.increments('id'); t.string('username').notNullable().unique(); t.string('display_name');
    t.string('password_hash'); t.string('source').notNullable().defaultTo('local');
    t.string('role').notNullable().defaultTo('technician'); t.boolean('active').notNullable().defaultTo(true);
    t.string('created_at');
  });
  await make('categories', t => { t.increments('id'); t.string('name').notNullable().unique(); });
  await make('items', t => {
    t.increments('id'); t.string('code').notNullable().unique(); t.string('name').notNullable();
    t.integer('category_id').references('id').inTable('categories');
    t.string('kind').notNullable().defaultTo('serialized');      // serialized | consumable
    t.string('status').notNullable().defaultTo('available');     // available | in_event | damaged | missing
    t.string('location'); t.string('serial_number'); t.string('photo_path');
    t.integer('quantity').notNullable().defaultTo(1); t.integer('min_quantity').notNullable().defaultTo(0);
    t.text('notes'); t.string('created_at'); t.string('updated_at');
    t.index('status');
  });
  await make('item_documents', t => {
    t.increments('id'); t.integer('item_id').notNullable().references('id').inTable('items');
    t.string('title'); t.string('path').notNullable(); t.string('created_at');
  });
  await make('events', t => {
    t.increments('id'); t.string('name').notNullable(); t.string('location');
    t.string('start_at').notNullable(); t.string('end_at').notNullable();   // ISO 8601 UTC
    t.string('status').notNullable().defaultTo('planned');                  // planned | out | returned
    t.integer('created_by').references('id').inTable('users'); t.string('created_at');
    t.index(['start_at', 'end_at']);
  });
  await make('event_items', t => {
    t.increments('id');
    t.integer('event_id').notNullable().references('id').inTable('events');
    t.integer('item_id').notNullable().references('id').inTable('items');
    t.integer('qty').notNullable().defaultTo(1);
    t.string('out_scanned_at'); t.integer('out_by'); t.string('in_scanned_at'); t.integer('in_by');
    t.string('return_state'); t.text('note'); t.string('photo_path');       // ok | damaged | missing
    t.unique(['event_id', 'item_id']); t.index('item_id');
  });
  await make('item_history', t => {
    t.increments('id'); t.integer('item_id').notNullable().references('id').inTable('items');
    t.integer('event_id'); t.string('action').notNullable(); t.integer('user_id'); t.string('username');
    t.text('note'); t.string('at').notNullable(); t.index('item_id');
  });
  await make('audit_logs', t => {
    t.increments('id'); t.integer('user_id'); t.string('username'); t.string('action').notNullable();
    t.string('entity'); t.integer('entity_id'); t.text('detail'); t.string('ip'); t.string('at').notNullable();
  });
}

module.exports = { db, init, ins };
