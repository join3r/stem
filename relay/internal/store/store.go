// Package store is the relay's SQLite file. Migrations only go forward.
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct{ db *sql.DB }

var migrations = []string{
	`CREATE TABLE relay_keys (kid TEXT PRIMARY KEY, priv BLOB NOT NULL, created INTEGER NOT NULL, active INTEGER NOT NULL);
	 CREATE TABLE accounts (fp TEXT PRIMARY KEY, auth_key TEXT NOT NULL, key_blob TEXT NOT NULL,
	   unlisted INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
	 CREATE TABLE addresses (address TEXT PRIMARY KEY, fp TEXT NOT NULL, verified INTEGER NOT NULL);
	 CREATE INDEX addresses_fp ON addresses(fp);
	 CREATE TABLE pending (address TEXT NOT NULL, fp TEXT NOT NULL, auth_key TEXT NOT NULL, key_blob TEXT NOT NULL,
	   code_hash TEXT NOT NULL, token TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
	   PRIMARY KEY (address, fp));
	 CREATE TABLE suppressed (address TEXT PRIMARY KEY, at INTEGER NOT NULL);
	 CREATE TABLE unsub_tokens (token TEXT PRIMARY KEY, address TEXT NOT NULL, at INTEGER NOT NULL);
	 CREATE TABLE allow (fp TEXT NOT NULL, address TEXT NOT NULL, PRIMARY KEY (fp, address));
	 CREATE TABLE block (fp TEXT NOT NULL, address TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (fp, address));
	 CREATE INDEX block_address ON block(address, at);
	 CREATE TABLE suspended (address TEXT PRIMARY KEY, at INTEGER NOT NULL);
	 CREATE TABLE mail (id TEXT PRIMARY KEY, to_addr TEXT NOT NULL, from_addr TEXT NOT NULL, size INTEGER NOT NULL,
	   envelope BLOB NOT NULL, received INTEGER NOT NULL, expires INTEGER NOT NULL);
	 CREATE INDEX mail_to ON mail(to_addr, received);
	 CREATE TABLE seen (id TEXT PRIMARY KEY, signer_fp TEXT NOT NULL, from_addr TEXT NOT NULL, to_addr TEXT NOT NULL,
	   at INTEGER NOT NULL, status TEXT NOT NULL);
	 CREATE TABLE knocks (from_addr TEXT NOT NULL, to_addr TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (from_addr, to_addr));
	 CREATE TABLE counters (k TEXT NOT NULL, bucket INTEGER NOT NULL, n INTEGER NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY (k, bucket));
	 CREATE TABLE invite_queue (to_addr TEXT PRIMARY KEY, senders TEXT NOT NULL, queued INTEGER NOT NULL);
	 CREATE TABLE invite_log (to_addr TEXT NOT NULL, at INTEGER NOT NULL, tag TEXT NOT NULL);
	 CREATE INDEX invite_log_to ON invite_log(to_addr, at);
	 CREATE TABLE invite_senders (tag TEXT NOT NULL, from_addr TEXT NOT NULL);
	 CREATE TABLE invite_banned (from_addr TEXT PRIMARY KEY, at INTEGER NOT NULL);
	 CREATE TABLE mail_events (tag TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL);
	 CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`,
	`CREATE TABLE push_tokens (token TEXT PRIMARY KEY, fp TEXT NOT NULL, used INTEGER NOT NULL);`,
	`CREATE TABLE shares (id TEXT PRIMARY KEY, owner TEXT NOT NULL, fp TEXT NOT NULL, size INTEGER NOT NULL, blob BLOB,
	   created INTEGER NOT NULL, expires INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0, removed_why TEXT NOT NULL DEFAULT '');
	 CREATE INDEX shares_owner ON shares(owner, created);
	 CREATE TABLE share_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, share TEXT NOT NULL, reason TEXT NOT NULL,
	   detail TEXT NOT NULL, contact TEXT NOT NULL, key TEXT NOT NULL, ip TEXT NOT NULL, at INTEGER NOT NULL,
	   handled INTEGER NOT NULL DEFAULT 0);`,
	`ALTER TABLE shares ADD COLUMN card_title TEXT NOT NULL DEFAULT '';
	 ALTER TABLE shares ADD COLUMN card_desc TEXT NOT NULL DEFAULT '';`,
	// Recipient-locked share links: who may open, the codes mailed to them,
	// the browsers that proved an address, and who opened when.
	`ALTER TABLE shares ADD COLUMN recipients TEXT NOT NULL DEFAULT '';
	 CREATE TABLE share_codes (share TEXT NOT NULL, address TEXT NOT NULL, code_hash TEXT NOT NULL,
	   expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (share, address));
	 CREATE TABLE share_views (token TEXT PRIMARY KEY, share TEXT NOT NULL, address TEXT NOT NULL, expires INTEGER NOT NULL);
	 CREATE TABLE share_opens (share TEXT NOT NULL, address TEXT NOT NULL, first INTEGER NOT NULL, last INTEGER NOT NULL,
	   count INTEGER NOT NULL, PRIMARY KEY (share, address));`,
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	return s, s.migrate()
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) DB() *sql.DB { return s.db }

func (s *Store) migrate() error {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS schema (version INTEGER NOT NULL)`); err != nil {
		return err
	}
	var v int
	if err := s.db.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema`).Scan(&v); err != nil {
		return err
	}
	if v > len(migrations) {
		return fmt.Errorf("database schema %d is newer than this relay (%d); upgrade the relay", v, len(migrations))
	}
	for i := v; i < len(migrations); i++ {
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema (version) VALUES (?)`, i+1); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

var ErrNotFound = errors.New("not found")

func now() int64 { return time.Now().UnixMilli() }

// ---- relay keys ----

type RelayKey struct {
	Kid    string
	Priv   []byte
	Active bool
}

func (s *Store) RelayKeys() ([]RelayKey, error) {
	rows, err := s.db.Query(`SELECT kid, priv, active FROM relay_keys ORDER BY created`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RelayKey
	for rows.Next() {
		var k RelayKey
		var a int
		if err := rows.Scan(&k.Kid, &k.Priv, &a); err != nil {
			return nil, err
		}
		k.Active = a == 1
		out = append(out, k)
	}
	return out, rows.Err()
}

func (s *Store) AddRelayKey(kid string, priv []byte, active bool) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	if active {
		if _, err := tx.Exec(`UPDATE relay_keys SET active = 0`); err != nil {
			tx.Rollback()
			return err
		}
	}
	if _, err := tx.Exec(`INSERT INTO relay_keys (kid, priv, created, active) VALUES (?, ?, ?, ?)`, kid, priv, now(), b2i(active)); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

func (s *Store) ActivateRelayKey(kid string) error {
	_, err := s.db.Exec(`UPDATE relay_keys SET active = (kid = ?)`, kid)
	return err
}

func (s *Store) RemoveRelayKey(kid string) error {
	_, err := s.db.Exec(`DELETE FROM relay_keys WHERE kid = ? AND active = 0`, kid)
	return err
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// ---- counters (fixed windows) ----

// Hit increments k in the current window and reports whether the count is
// still within limit. limit <= 0 means unlimited (but still counted).
func (s *Store) Hit(k string, window time.Duration, limit int) (bool, error) {
	w := window.Milliseconds()
	bucket := time.Now().UnixMilli() / w
	var n int
	err := s.db.QueryRow(`INSERT INTO counters (k, bucket, n, expires) VALUES (?, ?, 1, ?)
		ON CONFLICT (k, bucket) DO UPDATE SET n = n + 1 RETURNING n`, k, bucket, (bucket+1)*w).Scan(&n)
	if err != nil {
		return false, err
	}
	return limit <= 0 || n <= limit, nil
}

// Count reads k in the current window without incrementing.
func (s *Store) Count(k string, window time.Duration) (int, error) {
	bucket := time.Now().UnixMilli() / window.Milliseconds()
	var n int
	err := s.db.QueryRow(`SELECT n FROM counters WHERE k = ? AND bucket = ?`, k, bucket).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return n, err
}

func (s *Store) Meta(k string) (string, error) {
	var v string
	err := s.db.QueryRow(`SELECT v FROM meta WHERE k = ?`, k).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

func (s *Store) SetMeta(k, v string) error {
	_, err := s.db.Exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, k, v)
	return err
}

// Sweep deletes expired rows and marks expired held mail in seen.
func (s *Store) Sweep(holdDays int) error {
	t := now()
	if _, err := s.db.Exec(`UPDATE seen SET status = 'expired' WHERE status = 'pending' AND id IN (SELECT id FROM mail WHERE expires <= ?)`, t); err != nil {
		return err
	}
	stmts := []struct {
		q    string
		args []any
	}{
		{`DELETE FROM mail WHERE expires <= ?`, []any{t}},
		{`DELETE FROM seen WHERE at <= ?`, []any{t - int64(holdDays+1)*86400000}},
		{`DELETE FROM pending WHERE created <= ?`, []any{t - 86400000}},
		{`DELETE FROM counters WHERE expires <= ?`, []any{t}},
		{`DELETE FROM unsub_tokens WHERE at <= ?`, []any{t - 400*86400000}},
		{`DELETE FROM push_tokens WHERE used <= ?`, []any{t - 90*86400000}},
		// An expired share is gone for good; a revoked one keeps its
		// tombstone (so the link says "removed") for a year.
		{`DELETE FROM shares WHERE expires > 0 AND expires <= ?`, []any{t}},
		{`DELETE FROM shares WHERE removed > 0 AND removed <= ?`, []any{t - 365*86400000}},
		{`DELETE FROM share_codes WHERE expires <= ?`, []any{t}},
		{`DELETE FROM share_views WHERE expires <= ? OR share NOT IN (SELECT id FROM shares WHERE removed = 0)`, []any{t}},
		{`DELETE FROM share_opens WHERE share NOT IN (SELECT id FROM shares)`, nil},
	}
	for _, st := range stmts {
		if _, err := s.db.Exec(st.q, st.args...); err != nil {
			return err
		}
	}
	return nil
}

// ---- push tokens ----

// ClaimPushToken binds token to fp on first use and reports whether fp owns
// it. Another fp takes it over only once the owner has been idle for rebind.
func (s *Store) ClaimPushToken(token, fp string, rebind time.Duration) (bool, error) {
	t := now()
	res, err := s.db.Exec(`INSERT INTO push_tokens (token, fp, used) VALUES (?, ?, ?)
		ON CONFLICT (token) DO UPDATE SET fp = excluded.fp, used = excluded.used
		WHERE push_tokens.fp = excluded.fp OR push_tokens.used <= ?`, token, fp, t, t-rebind.Milliseconds())
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

func (s *Store) DropPushToken(token string) error {
	_, err := s.db.Exec(`DELETE FROM push_tokens WHERE token = ?`, token)
	return err
}
