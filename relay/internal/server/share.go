package server

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"html"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/join3r/stem/relay/internal/store"
)

// Public share links (PROTOCOL.md, "Share links"). A Stem encrypts the
// snapshot itself and keeps the key in the link's fragment, so a blob here
// is opaque bytes: the relay can count, expire and remove them, never read
// them. Uploads need a sender certificate, so every share traces back to a
// verified address.

var shareIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

// A blob is version byte 1, a 12-byte nonce, then AES-GCM output (at least
// the 16-byte tag).
const shareMinBytes = 1 + 12 + 16

func newShareID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (s *Server) shareOn() error {
	if !s.cfg.Share.Enabled {
		return fail(404, "share_disabled")
	}
	return nil
}

func (s *Server) shareURL(id string) string { return s.cfg.Share.ViewerURL + "/s/" + id }

func (s *Server) postShare(w http.ResponseWriter, r *http.Request, body []byte) error {
	if err := s.shareOn(); err != nil {
		return err
	}
	addr, fp, err := s.certified(r, body)
	if err != nil {
		return err
	}
	if len(body) < shareMinBytes || body[0] != 1 {
		return fail(400, "bad_blob")
	}
	cfg := s.cfg.Share
	// No ttl means the longest allowed; with max_ttl_days = 0 that is never.
	days := cfg.MaxTTLDays
	if v := r.URL.Query().Get("ttl"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 3650 || cfg.MaxTTLDays > 0 && n > cfg.MaxTTLDays {
			return fail(400, "bad_ttl")
		}
		days = n
	}
	var expires int64
	if days > 0 {
		expires = s.Now().Add(time.Duration(days) * day).UnixMilli()
	}
	cardTitle, cardDesc, err := parseCard(r.URL.Query().Get("card"))
	if err != nil {
		return err
	}
	recipients, err := parseRecipients(r.URL.Query().Get("to"), cfg.MaxRecipients)
	if err != nil {
		return err
	}
	live, used, err := s.st.OwnerShareUsage(addr)
	if err != nil {
		return err
	}
	if cfg.MaxLive > 0 && live >= cfg.MaxLive {
		return fail(507, "too_many_links")
	}
	if cfg.QuotaBytes > 0 && used+int64(len(body)) > cfg.QuotaBytes {
		return fail(507, "quota_full")
	}
	if ok, err := s.hit("share:addr:"+addr, day, cfg.PerAddressDay); err != nil {
		return err
	} else if !ok {
		return fail(429, "rate_limited")
	}
	sh := &store.Share{ID: newShareID(), Owner: addr, Fp: fp, Size: int64(len(body)), Blob: body,
		Created: s.Now().UnixMilli(), Expires: expires, CardTitle: cardTitle, CardDesc: cardDesc, Recipients: recipients}
	if err := s.st.PutShare(sh); err != nil {
		return err
	}
	out := map[string]any{"id": sh.ID, "url": s.shareURL(sh.ID), "expires": expires}
	if len(recipients) > 0 {
		// The Stem checks this: a relay without locked links would have
		// ignored ?to= and made the link public.
		out["recipients"] = recipients
	}
	writeJSON(w, 200, out)
	return nil
}

func (s *Server) getShare(w http.ResponseWriter, r *http.Request, _ []byte) error {
	if err := s.shareOn(); err != nil {
		return err
	}
	id := r.PathValue("id")
	if !shareIDRe.MatchString(id) {
		return fail(404, "not_found")
	}
	sh, err := s.st.GetShare(id)
	if errors.Is(err, store.ErrNotFound) {
		return fail(404, "not_found")
	} else if err != nil {
		return err
	}
	h := w.Header()
	h.Set("X-Robots-Tag", "noindex")
	h.Set("X-Content-Type-Options", "nosniff")
	if sh.Removed > 0 {
		// The owner revoked it or it was taken down: say which, nothing else.
		why := "revoked"
		if sh.RemovedWhy != "owner" {
			why = "taken_down"
		}
		h.Set("Cache-Control", "no-store")
		writeJSON(w, 410, map[string]string{"error": "gone", "why": why})
		return nil
	}
	if len(sh.Recipients) > 0 {
		// Locked: only a browser that entered a mailed code gets the blob.
		h.Set("Cache-Control", "no-store")
		who, err := s.viewer(r, sh)
		if err != nil {
			return err
		}
		if who == "" {
			writeJSON(w, 401, map[string]any{"error": "locked", "recipients": masked(sh.Recipients)})
			return nil
		}
		if err := s.st.RecordShareOpen(sh.ID, who, s.Now().UnixMilli()); err != nil {
			return err
		}
	} else {
		// Short cache, so a revoke takes effect within a minute.
		h.Set("Cache-Control", "private, max-age=60")
	}
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Length", strconv.Itoa(len(sh.Blob)))
	_, _ = w.Write(sh.Blob)
	return nil
}

func (s *Server) deleteShare(w http.ResponseWriter, r *http.Request, body []byte) error {
	if err := s.shareOn(); err != nil {
		return err
	}
	addr, _, err := s.certified(r, body)
	if err != nil {
		return err
	}
	id := r.PathValue("id")
	sh, err := s.st.GetShare(id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, 200, map[string]any{}) // already gone
		return nil
	} else if err != nil {
		return err
	}
	// The address owns it, not the key: a new device holding the same
	// address can still revoke what an old one shared.
	if sh.Owner != addr {
		return fail(404, "not_found")
	}
	if _, err := s.st.RemoveShare(id, "owner"); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{})
	return nil
}

func (s *Server) listShares(w http.ResponseWriter, r *http.Request, body []byte) error {
	if err := s.shareOn(); err != nil {
		return err
	}
	addr, _, err := s.certified(r, body)
	if err != nil {
		return err
	}
	rows, err := s.st.OwnerShares(addr)
	if err != nil {
		return err
	}
	opens, err := s.st.OwnerShareOpens(addr)
	if err != nil {
		return err
	}
	out := make([]map[string]any, 0, len(rows))
	for _, sh := range rows {
		row := map[string]any{"id": sh.ID, "url": s.shareURL(sh.ID), "size": sh.Size, "created": sh.Created, "expires": sh.Expires}
		if len(sh.Recipients) > 0 {
			row["recipients"] = sh.Recipients
			o := opens[sh.ID]
			if o == nil {
				o = []store.ShareOpen{}
			}
			row["opens"] = o
		}
		out = append(out, row)
	}
	writeJSON(w, 200, map[string]any{"shares": out})
	return nil
}

var shareReasons = map[string]bool{"illegal": true, "privacy": true, "harassment": true, "spam": true, "other": true}

// printable drops control characters (C0 except newline, DEL, C1): report
// text is anonymous and ends up in an operator's terminal (share-reports).
func printable(v string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r >= 0x20 && r != 0x7f && (r < 0x80 || r > 0x9f) {
			return r
		}
		return -1
	}, v)
}

var shareKeyRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

func clip(v string, n int) string {
	v = strings.TrimSpace(printable(v))
	if len(v) <= n {
		return v
	}
	v = v[:n]
	for !utf8.ValidString(v) {
		v = v[:len(v)-1]
	}
	return v
}

// reportShare is the notice-and-action form. A reporter may include the
// link's key, consenting to let the operator see what they saw.
func (s *Server) reportShare(w http.ResponseWriter, r *http.Request, body []byte) error {
	if err := s.shareOn(); err != nil {
		return err
	}
	id := r.PathValue("id")
	if !shareIDRe.MatchString(id) {
		return fail(404, "not_found")
	}
	var in struct {
		Reason  string `json:"reason"`
		Detail  string `json:"detail"`
		Contact string `json:"contact"`
		Key     string `json:"key"`
	}
	if err := decode(body, &in); err != nil {
		return err
	}
	if !shareReasons[in.Reason] {
		return fail(400, "bad_reason")
	}
	ip := ipBucket(s.clientIP(r))
	if ok, err := s.hit("share:report:"+ip, time.Hour, s.cfg.Share.ReportsPerIPHour); err != nil {
		return err
	} else if !ok {
		return fail(429, "rate_limited")
	}
	if _, err := s.st.GetShare(id); errors.Is(err, store.ErrNotFound) {
		return fail(404, "not_found")
	} else if err != nil {
		return err
	}
	if in.Key != "" && !shareKeyRe.MatchString(in.Key) {
		return fail(400, "bad_key")
	}
	rep := &store.ShareReport{Share: id, Reason: in.Reason, Detail: clip(in.Detail, 4000),
		Contact: strings.ReplaceAll(clip(in.Contact, 256), "\n", " "), Key: in.Key, IP: ip}
	if err := s.st.AddShareReport(rep); err != nil {
		return err
	}
	log.Printf("share: report on %s (%s)", id, in.Reason)
	writeJSON(w, 202, map[string]any{})
	return nil
}

// ---- link previews ----

const (
	cardTitleMax = 120
	cardDescMax  = 300
)

// parseCard reads the optional link preview a Stem publishes in the clear
// (?card=base64url(JSON {"t","d"})); it rides in the signed path. One line
// each, printable only, clipped.
func parseCard(v string) (string, string, error) {
	if v == "" {
		return "", "", nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(v)
	if err != nil || len(raw) > 4096 {
		return "", "", fail(400, "bad_card")
	}
	var c struct {
		T string `json:"t"`
		D string `json:"d"`
	}
	if json.Unmarshal(raw, &c) != nil {
		return "", "", fail(400, "bad_card")
	}
	line := func(v string, n int) string { return clip(strings.Join(strings.Fields(printable(v)), " "), n) }
	return line(c.T, cardTitleMax), line(c.D, cardDescMax), nil
}

// sharePage serves the viewer's index.html for /s/<id> with that share's
// preview tags (between <!--stem-card--> markers), so chat apps that unfurl
// the link show its card. The page and every response say noindex: previews
// yes, search results no. The fragment (the key) never reaches here.
func (s *Server) sharePage(w http.ResponseWriter, r *http.Request, _ []byte) error {
	if !s.onViewerHost(r) {
		return fail(404, "not_found")
	}
	page, err := os.ReadFile(filepath.Join(s.cfg.Share.ViewerDir, "index.html"))
	if err != nil {
		return err
	}
	id := r.PathValue("id")
	var sh *store.Share
	if shareIDRe.MatchString(id) {
		if got, err := s.st.GetShare(id); err == nil {
			sh = got
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
	}
	h := w.Header()
	h.Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	h.Set("Cache-Control", "no-cache")
	h.Set("Content-Type", "text/html; charset=utf-8")
	if sh == nil || sh.Removed > 0 {
		page = withCard(page, "Link removed · Stem", "This shared page is no longer available.", s.cfg.Share.ViewerURL, "")
	} else if sh.CardTitle != "" || sh.CardDesc != "" {
		title := sh.CardTitle
		if title == "" {
			title = "Shared from Stem"
		}
		page = withCard(page, title, sh.CardDesc, s.cfg.Share.ViewerURL, s.shareURL(sh.ID))
	}
	_, _ = w.Write(page)
	return nil
}

// onViewerHost: the viewer is only served on its own origin (viewer_url),
// never on the relay's, so shared pages don't run where relay calls do.
func (s *Server) onViewerHost(r *http.Request) bool {
	if !s.cfg.Share.Enabled || s.cfg.Share.ViewerDir == "" {
		return false
	}
	u, err := url.Parse(s.cfg.Share.ViewerURL)
	return err == nil && strings.EqualFold(r.Host, u.Host)
}

// viewerAsset serves the viewer's built files (hashed assets, icons).
func (s *Server) viewerAsset(w http.ResponseWriter, r *http.Request) {
	if !s.onViewerHost(r) {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	h.Set("X-Content-Type-Options", "nosniff")
	if strings.HasPrefix(r.URL.Path, "/assets/") {
		h.Set("Cache-Control", "public, max-age=31536000, immutable") // names carry a content hash
	} else {
		h.Set("Cache-Control", "public, max-age=3600")
	}
	http.FileServer(http.Dir(s.cfg.Share.ViewerDir)).ServeHTTP(w, r)
}

func withCard(page []byte, title, desc, base, url string) []byte {
	start, end := []byte("<!--stem-card-->"), []byte("<!--/stem-card-->")
	i, j := strings.Index(string(page), string(start)), strings.Index(string(page), string(end))
	if i < 0 || j < i {
		return page
	}
	e := html.EscapeString
	var b strings.Builder
	b.WriteString("<!--stem-card-->\n")
	b.WriteString("    <title>" + e(title) + "</title>\n")
	b.WriteString(`    <meta property="og:site_name" content="Stem" />` + "\n")
	b.WriteString(`    <meta property="og:type" content="article" />` + "\n")
	b.WriteString(`    <meta property="og:title" content="` + e(title) + `" />` + "\n")
	if desc != "" {
		b.WriteString(`    <meta property="og:description" content="` + e(desc) + `" />` + "\n")
		b.WriteString(`    <meta name="description" content="` + e(desc) + `" />` + "\n")
	}
	if url != "" {
		b.WriteString(`    <meta property="og:url" content="` + e(url) + `" />` + "\n")
	}
	b.WriteString(`    <meta property="og:image" content="` + e(base) + `/og.png" />` + "\n")
	b.WriteString(`    <meta name="twitter:card" content="summary" />` + "\n    ")
	out := append([]byte{}, page[:i]...)
	out = append(out, b.String()...)
	return append(out, page[j:]...)
}
