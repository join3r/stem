package store

import (
	"database/sql"
	"encoding/json"
	"errors"
)

// Share is one public share link's row. Blob is nil once removed.
type Share struct {
	ID         string
	Owner      string
	Fp         string
	Size       int64
	Blob       []byte
	Created    int64
	Expires    int64 // 0 = never
	Removed    int64 // 0 = live
	RemovedWhy string
	// The link preview the sharer chose to publish in the clear (may be empty).
	CardTitle string
	CardDesc  string
	// The addresses that may open it; empty = anyone with the link.
	Recipients []string
}

func recipientsColumn(r []string) string {
	if len(r) == 0 {
		return ""
	}
	b, _ := json.Marshal(r)
	return string(b)
}

func parseRecipients(v string) []string {
	var r []string
	if v != "" {
		_ = json.Unmarshal([]byte(v), &r)
	}
	return r
}

func (s *Store) PutShare(sh *Share) error {
	_, err := s.db.Exec(`INSERT INTO shares (id, owner, fp, size, blob, created, expires, card_title, card_desc, recipients)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sh.ID, sh.Owner, sh.Fp, sh.Size, sh.Blob, sh.Created, sh.Expires, sh.CardTitle, sh.CardDesc, recipientsColumn(sh.Recipients))
	return err
}

// GetShare returns the row with its blob. An expired share not yet swept
// reads as not found.
func (s *Store) GetShare(id string) (*Share, error) {
	var sh Share
	var recipients string
	err := s.db.QueryRow(`SELECT id, owner, fp, size, blob, created, expires, removed, removed_why, card_title, card_desc, recipients
		FROM shares WHERE id = ?`, id).
		Scan(&sh.ID, &sh.Owner, &sh.Fp, &sh.Size, &sh.Blob, &sh.Created, &sh.Expires, &sh.Removed, &sh.RemovedWhy,
			&sh.CardTitle, &sh.CardDesc, &recipients)
	sh.Recipients = parseRecipients(recipients)
	if errors.Is(err, sql.ErrNoRows) || err == nil && sh.Expires > 0 && sh.Expires <= now() {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &sh, nil
}

// RemoveShare drops the blob and keeps a tombstone. It reports whether a
// live share was removed.
func (s *Store) RemoveShare(id, why string) (bool, error) {
	res, err := s.db.Exec(`UPDATE shares SET blob = NULL, card_title = '', card_desc = '', recipients = '', removed = ?, removed_why = ?
		WHERE id = ? AND removed = 0`, now(), why, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	// Who it was shared with goes with the content.
	for _, q := range []string{`DELETE FROM share_codes WHERE share = ?`, `DELETE FROM share_views WHERE share = ?`, `DELETE FROM share_opens WHERE share = ?`} {
		if _, err := s.db.Exec(q, id); err != nil {
			return false, err
		}
	}
	return n == 1, nil
}

// OwnerShares lists an address's live shares, newest first, without blobs.
func (s *Store) OwnerShares(owner string) ([]Share, error) {
	rows, err := s.db.Query(`SELECT id, size, created, expires, recipients FROM shares
		WHERE owner = ? AND removed = 0 AND (expires = 0 OR expires > ?) ORDER BY created DESC`, owner, now())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Share
	for rows.Next() {
		sh := Share{Owner: owner}
		var recipients string
		if err := rows.Scan(&sh.ID, &sh.Size, &sh.Created, &sh.Expires, &recipients); err != nil {
			return nil, err
		}
		sh.Recipients = parseRecipients(recipients)
		out = append(out, sh)
	}
	return out, rows.Err()
}

// OwnerShareUsage is how many live shares an address holds and their bytes.
func (s *Store) OwnerShareUsage(owner string) (count int, bytes int64, err error) {
	err = s.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(size), 0) FROM shares WHERE owner = ? AND removed = 0 AND (expires = 0 OR expires > ?)`,
		owner, now()).Scan(&count, &bytes)
	return count, bytes, err
}

// ---- recipient-locked shares ----

// ShareCodeTries is how many wrong codes end a mailed code.
const ShareCodeTries = 5

// PutShareCode stores (or replaces) the code mailed to one recipient.
func (s *Store) PutShareCode(share, address, hash string, expires int64) error {
	_, err := s.db.Exec(`INSERT INTO share_codes (share, address, code_hash, expires, tries) VALUES (?, ?, ?, ?, 0)
		ON CONFLICT (share, address) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires, tries = 0`,
		share, address, hash, expires)
	return err
}

// UseShareCode reports whether hash is the live code for that recipient. A
// match uses the code up; every try counts against ShareCodeTries. The try
// is taken in one atomic UPDATE before the compare, so parallel guesses
// cannot pass the limit.
func (s *Store) UseShareCode(share, address, hash string) (bool, error) {
	var want string
	err := s.db.QueryRow(`UPDATE share_codes SET tries = tries + 1
		WHERE share = ? AND address = ? AND tries < ? AND expires > ? RETURNING code_hash`,
		share, address, ShareCodeTries, now()).Scan(&want)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	if want != hash {
		return false, nil
	}
	res, err := s.db.Exec(`DELETE FROM share_codes WHERE share = ? AND address = ? AND code_hash = ?`, share, address, hash)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// PutShareView remembers a browser that proved an address (by token hash).
func (s *Store) PutShareView(tokenHash, share, address string, expires int64) error {
	_, err := s.db.Exec(`INSERT INTO share_views (token, share, address, expires) VALUES (?, ?, ?, ?)`, tokenHash, share, address, expires)
	return err
}

// ShareView returns the address a live view token proved for that share.
func (s *Store) ShareView(tokenHash, share string) (string, error) {
	var addr string
	err := s.db.QueryRow(`SELECT address FROM share_views WHERE token = ? AND share = ? AND expires > ?`, tokenHash, share, now()).Scan(&addr)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return addr, err
}

// ShareOpen is one recipient's opening record.
type ShareOpen struct {
	Address string `json:"address"`
	First   int64  `json:"first"`
	Last    int64  `json:"last"`
	Count   int    `json:"count"`
}

// RecordShareOpen counts one opening of share by address at t.
func (s *Store) RecordShareOpen(share, address string, t int64) error {
	_, err := s.db.Exec(`INSERT INTO share_opens (share, address, first, last, count) VALUES (?, ?, ?, ?, 1)
		ON CONFLICT (share, address) DO UPDATE SET last = excluded.last, count = count + 1`, share, address, t, t)
	return err
}

// OwnerShareOpens returns the opening records of an address's shares, by share id.
func (s *Store) OwnerShareOpens(owner string) (map[string][]ShareOpen, error) {
	rows, err := s.db.Query(`SELECT o.share, o.address, o.first, o.last, o.count FROM share_opens o
		JOIN shares sh ON sh.id = o.share WHERE sh.owner = ? AND sh.removed = 0 ORDER BY o.first`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]ShareOpen{}
	for rows.Next() {
		var id string
		var o ShareOpen
		if err := rows.Scan(&id, &o.Address, &o.First, &o.Last, &o.Count); err != nil {
			return nil, err
		}
		out[id] = append(out[id], o)
	}
	return out, rows.Err()
}

type ShareReport struct {
	ID      int64
	Share   string
	Reason  string
	Detail  string
	Contact string
	Key     string
	IP      string
	At      int64
}

func (s *Store) AddShareReport(r *ShareReport) error {
	_, err := s.db.Exec(`INSERT INTO share_reports (share, reason, detail, contact, key, ip, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		r.Share, r.Reason, r.Detail, r.Contact, r.Key, r.IP, now())
	return err
}

// OpenShareReports lists reports not yet marked handled, oldest first.
func (s *Store) OpenShareReports() ([]ShareReport, error) {
	rows, err := s.db.Query(`SELECT id, share, reason, detail, contact, key, ip, at FROM share_reports WHERE handled = 0 ORDER BY at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ShareReport
	for rows.Next() {
		var r ShareReport
		if err := rows.Scan(&r.ID, &r.Share, &r.Reason, &r.Detail, &r.Contact, &r.Key, &r.IP, &r.At); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// HandleShareReports marks every report on a share handled.
func (s *Store) HandleShareReports(share string) error {
	_, err := s.db.Exec(`UPDATE share_reports SET handled = 1 WHERE share = ?`, share)
	return err
}
