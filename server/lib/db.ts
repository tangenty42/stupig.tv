import { load_database_config } from '@config/loader'
import mysql from 'mysql2/promise'

const config = load_database_config()

const pool = mysql.createPool({
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
  database: config.name,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: 'Z',
})

// Force UTC for every physical connection. The pool 'connection' event fires for
// ALL connections, including the ones acquired internally by pool.execute/query,
// so this covers every query path (the previous getConnection override was never
// hit by db.execute and left the session at the server default time_zone).
pool.on('connection', (connection) => {
  connection.query('SET time_zone = "+00:00"')
})

export const db = pool
