// Remote SQLite client that mimics the better-sqlite3 sync API.
// Uses execFileSync + curl with stdin to safely pass JSON payloads.

const { execFileSync } = require('child_process');

class RemoteStatement {
  constructor(client, sql) {
    this.client = client;
    this.sql = sql;
  }

  get(...params) {
    const res = this.client._request('/api/db/get', { sql: this.sql, params });
    return res.row;
  }

  all(...params) {
    const res = this.client._request('/api/db/all', { sql: this.sql, params });
    return res.rows;
  }

  run(...params) {
    return this.client._request('/api/db/run', { sql: this.sql, params });
  }
}

class RemoteDatabase {
  constructor(url, apiKey) {
    this.url = url.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  _request(endpoint, body) {
    const payload = JSON.stringify(body);

    try {
      const result = execFileSync('curl', [
        '-s', '-X', 'POST',
        `${this.url}${endpoint}`,
        '-H', 'Content-Type: application/json',
        '-H', `Authorization: Bearer ${this.apiKey}`,
        '-d', '@-',  // read body from stdin
      ], {
        input: payload,
        encoding: 'utf-8',
        timeout: 15000,
      });

      const parsed = JSON.parse(result);
      if (parsed.error) throw new Error(parsed.error);
      return parsed;
    } catch (err) {
      if (err.status) {
        throw new Error(`DB proxy niet bereikbaar: ${this.url}`);
      }
      throw err;
    }
  }

  prepare(sql) {
    return new RemoteStatement(this, sql);
  }

  exec(sql) {
    this._request('/api/db/exec', { sql });
  }

  pragma(p) {
    const res = this._request('/api/db/pragma', { pragma: p });
    return res.result;
  }

  transaction(fn) {
    return (...args) => fn(...args);
  }
}

module.exports = { RemoteDatabase };
