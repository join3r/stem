package server

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/join3r/stem/relay/internal/mailer"
	"github.com/join3r/stem/relay/internal/proto"
	"github.com/join3r/stem/relay/internal/store"
)

// Recipient-locked share links (PROTOCOL.md, "Share links"). The sharer
// names the addresses that may open the link. A visitor must enter a code
// the relay mails to one of them before the relay hands out the blob. The
// key still rides only in the link's fragment, so a link needs both: the
// link (for the key) and the inbox (for the code).

const (
	shareCodeTTL    = 15 * time.Minute
	shareViewCookie = "stem_view"
)

// parseRecipients reads ?to=base64url(JSON ["a@b", …]); it rides in the
// signed path. Normalised, deduplicated, at most max.
func parseRecipients(v string, max int) ([]string, error) {
	if v == "" {
		return nil, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(v)
	if err != nil || len(raw) > 16<<10 {
		return nil, fail(400, "bad_recipients")
	}
	var in []string
	if json.Unmarshal(raw, &in) != nil {
		return nil, fail(400, "bad_recipients")
	}
	seen := map[string]bool{}
	var out []string
	for _, a := range in {
		addr, err := addressArg(a)
		if err != nil {
			return nil, fail(400, "bad_recipients")
		}
		if !seen[addr] {
			seen[addr] = true
			out = append(out, addr)
		}
	}
	if len(out) == 0 || max > 0 && len(out) > max {
		return nil, fail(400, "bad_recipients")
	}
	return out, nil
}

// maskAddress shows enough of an address for its owner to know it:
// "martin@gmail.com" → "m•••@gmail.com".
func maskAddress(a string) string {
	at := strings.LastIndex(a, "@")
	if at < 1 {
		return "•••"
	}
	first := []rune(a[:at])[0]
	return string(first) + "•••" + a[at:]
}

func masked(r []string) []string {
	out := make([]string, len(r))
	for i, a := range r {
		out[i] = maskAddress(a)
	}
	return out
}

func viewTokenHash(token string) string {
	return proto.SHA256Hex([]byte("stem-share-view-v1\n" + token))
}

func shareCodeHash(code, share, address string) string {
	return proto.SHA256Hex([]byte("stem-share-code-v1\n" + code + "\n" + share + "\n" + address))
}

// viewer returns the recipient this request's browser proved, or "".
func (s *Server) viewer(r *http.Request, sh *store.Share) (string, error) {
	c, err := r.Cookie(shareViewCookie)
	if err != nil || c.Value == "" {
		return "", nil
	}
	addr, err := s.st.ShareView(viewTokenHash(c.Value), sh.ID)
	if errors.Is(err, store.ErrNotFound) {
		return "", nil
	}
	return addr, err
}

// lockedShare loads a live, locked share for the code and unlock calls.
func (s *Server) lockedShare(r *http.Request) (*store.Share, error) {
	if err := s.shareOn(); err != nil {
		return nil, err
	}
	id := r.PathValue("id")
	if !shareIDRe.MatchString(id) {
		return nil, fail(404, "not_found")
	}
	sh, err := s.st.GetShare(id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, fail(404, "not_found")
	} else if err != nil {
		return nil, err
	}
	if sh.Removed > 0 {
		return nil, fail(410, "gone")
	}
	if len(sh.Recipients) == 0 {
		return nil, fail(400, "not_locked")
	}
	return sh, nil
}

func recipientArg(sh *store.Share, i *int) (string, error) {
	if i == nil || *i < 0 || *i >= len(sh.Recipients) {
		return "", fail(400, "bad_recipient")
	}
	return sh.Recipients[*i], nil
}

// shareCode mails a one-time code to one of the share's recipients. The
// visitor picks the recipient by index, so the page never learns the full
// address.
func (s *Server) shareCode(w http.ResponseWriter, r *http.Request, body []byte) error {
	sh, err := s.lockedShare(r)
	if err != nil {
		return err
	}
	var in struct {
		R *int `json:"r"`
	}
	if err := decode(body, &in); err != nil {
		return err
	}
	addr, err := recipientArg(sh, in.R)
	if err != nil {
		return err
	}
	cfg := s.cfg.Share
	for _, c := range []struct {
		k      string
		window time.Duration
		n      int
	}{
		{"share:code:wait:" + sh.ID + ":" + addr, time.Minute, 1},
		// Per share, so a visitor of one link cannot use up the codes for
		// the recipient's other links…
		{"share:code:to:" + sh.ID + ":" + addr, day, cfg.CodesPerRecipientDay},
		// …and a wider cap over all shares, so a sharer cannot spam an
		// address with many links.
		{"share:code:all:" + addr, day, 5 * cfg.CodesPerRecipientDay},
		{"share:code:ip:" + ipBucket(s.clientIP(r)), day, cfg.CodesPerIPDay},
	} {
		if ok, err := s.hit(c.k, c.window, c.n); err != nil {
			return err
		} else if !ok {
			return fail(429, "rate_limited")
		}
	}
	// An address that asked never to get mail from the relay reads the same
	// as one that got it: the visitor learns nothing.
	if sup, err := s.st.Suppressed(addr); err != nil {
		return err
	} else if sup {
		writeJSON(w, 202, map[string]any{})
		return nil
	}
	code := randomDigits(6)
	if err := s.st.PutShareCode(sh.ID, addr, shareCodeHash(code, sh.ID, addr), s.Now().Add(shareCodeTTL).UnixMilli()); err != nil {
		return err
	}
	unsub := randomToken()
	if err := s.st.PutUnsubToken(unsub, addr); err != nil {
		return err
	}
	stop := s.cfg.URL + "/v1/unsubscribe?t=" + unsub
	text := fmt.Sprintf("%s shared a page with you on Stem, and someone just asked to open it.\n\n"+
		"Your code is %s. It works for %d minutes.\n\n"+
		"If that was not you, ignore this email. The page stays locked without the code.\n\n"+
		"Never email me again: %s\n", sh.Owner, code, int(shareCodeTTL/time.Minute), stop)
	msg := mailer.Message{Kind: mailer.Verify, To: addr, Subject: "Your Stem code: " + code, Body: text, Tag: "s-" + unsub[:12]}
	if err := s.mail.Send(msg); err != nil {
		log.Printf("share code mail to %s failed: %v", addr, err)
	}
	writeJSON(w, 202, map[string]any{})
	return nil
}

// shareUnlock checks a code. A match sets a cookie, scoped to this share,
// that lets the browser read it for view_days.
func (s *Server) shareUnlock(w http.ResponseWriter, r *http.Request, body []byte) error {
	sh, err := s.lockedShare(r)
	if err != nil {
		return err
	}
	var in struct {
		R    *int   `json:"r"`
		Code string `json:"code"`
	}
	if err := decode(body, &in); err != nil {
		return err
	}
	addr, err := recipientArg(sh, in.R)
	if err != nil {
		return err
	}
	for _, c := range []struct {
		k string
		n int
	}{{"share:unlock:ip:" + ipBucket(s.clientIP(r)), 30}, {"share:unlock:to:" + sh.ID + ":" + addr, 20}} {
		if ok, err := s.hit(c.k, time.Hour, c.n); err != nil {
			return err
		} else if !ok {
			return fail(429, "rate_limited")
		}
	}
	code := strings.TrimSpace(in.Code)
	ok, err := s.st.UseShareCode(sh.ID, addr, shareCodeHash(code, sh.ID, addr))
	if err != nil {
		return err
	}
	if !ok {
		return fail(403, "bad_code")
	}
	days := s.cfg.Share.ViewDays
	if days < 1 {
		days = 1
	}
	token := randomToken()
	if err := s.st.PutShareView(viewTokenHash(token), sh.ID, addr, s.Now().Add(time.Duration(days)*day).UnixMilli()); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     shareViewCookie,
		Value:    token,
		Path:     "/v1/shares/" + sh.ID,
		MaxAge:   days * 86400,
		HttpOnly: true,
		Secure:   strings.HasPrefix(s.cfg.Share.ViewerURL, "https://"),
		SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, 200, map[string]any{})
	return nil
}
