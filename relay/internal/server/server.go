// Package server is the relay's HTTP API (PROTOCOL.md).
package server

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/join3r/stem/relay/internal/authority"
	"github.com/join3r/stem/relay/internal/config"
	"github.com/join3r/stem/relay/internal/mailer"
	"github.com/join3r/stem/relay/internal/proto"
	"github.com/join3r/stem/relay/internal/store"
)

const Version = "1.0.0"

type Server struct {
	cfg      *config.Config
	st       *store.Store
	mail     mailer.Mailer
	resolver *authority.Resolver
	Now      func() time.Time

	keysMu  sync.RWMutex
	signKid string
	signKey ed25519.PrivateKey
	pubKeys map[string]ed25519.PublicKey

	hub       *hub
	mailSlots chan struct{}
	ipSlots   counted
	streams   counted

	// Pusher is set when [push] is enabled; nil answers push_disabled.
	Pusher Pusher
}

func New(cfg *config.Config, st *store.Store, m mailer.Mailer, res *authority.Resolver) (*Server, error) {
	s := &Server{cfg: cfg, st: st, mail: m, resolver: res, Now: time.Now, hub: newHub(), mailSlots: make(chan struct{}, 32)}
	if err := s.LoadKeys(); err != nil {
		return nil, err
	}
	if cfg.Global {
		res.GlobalURL = cfg.URL
		res.GlobalKeys = s.PublicKeys()
	}
	return s, nil
}

// LoadKeys reads the relay's signing keys, creating the first one.
func (s *Server) LoadKeys() error {
	keys, err := s.st.RelayKeys()
	if err != nil {
		return err
	}
	if len(keys) == 0 {
		_, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		if err := s.st.AddRelayKey("k1", priv, true); err != nil {
			return err
		}
		keys, _ = s.st.RelayKeys()
	}
	pubs := map[string]ed25519.PublicKey{}
	var kid string
	var priv ed25519.PrivateKey
	for _, k := range keys {
		p := ed25519.PrivateKey(k.Priv)
		pubs[k.Kid] = p.Public().(ed25519.PublicKey)
		if k.Active {
			kid, priv = k.Kid, p
		}
	}
	if priv == nil {
		return errors.New("no active relay key")
	}
	s.keysMu.Lock()
	s.signKid, s.signKey, s.pubKeys = kid, priv, pubs
	s.keysMu.Unlock()
	if s.cfg.Global && s.resolver != nil {
		s.resolver.GlobalKeys = pubs
	}
	return nil
}

func (s *Server) PublicKeys() map[string]ed25519.PublicKey {
	s.keysMu.RLock()
	defer s.keysMu.RUnlock()
	return s.pubKeys
}

// Serves reports whether this relay is the authority for an address.
func (s *Server) Serves(address string) (bool, error) {
	d := proto.Domain(address)
	if !s.cfg.Global {
		return slices.Contains(s.cfg.Domains, d), nil
	}
	rec, err := s.resolver.DomainRecord(d)
	if err != nil {
		return false, err
	}
	return rec == nil, nil
}

// errOutsider: the sender is outside a closed relay's circle, or belongs to a
// closed domain this relay doesn't serve.
var errOutsider = fail(403, "closed_relay")

// outsider reports whether certificates for the address must be refused:
// on a closed relay, anyone outside its domains and partners; on any relay,
// the people of a domain whose record says access=closed, unless we serve it.
func (s *Server) outsider(address string) (bool, error) {
	d := proto.Domain(address)
	if slices.Contains(s.cfg.Domains, d) {
		return false, nil
	}
	if s.cfg.Closed {
		return !slices.Contains(s.cfg.PartnerDomains, d), nil
	}
	rec, err := s.resolver.DomainRecord(d)
	if err != nil {
		return false, err
	}
	return rec != nil && rec.Closed, nil
}

// issuerKeys verifies certificates: our own keys for our addresses, DNS or
// the global relay for everyone else. Outsiders (see outsider) get none.
func (s *Server) issuerKeys(address string) (string, map[string]ed25519.PublicKey, error) {
	if out, err := s.outsider(address); err != nil {
		return "", nil, err
	} else if out {
		return "", nil, errOutsider
	}
	if ok, err := s.Serves(address); err != nil {
		return "", nil, err
	} else if ok {
		return s.cfg.URL, s.PublicKeys(), nil
	}
	return s.resolver.Authority(address)
}

func (s *Server) issueCert(address, fp string) *proto.Cert {
	s.keysMu.RLock()
	kid, priv := s.signKid, s.signKey
	s.keysMu.RUnlock()
	t := s.Now()
	c := &proto.Cert{V: 1, Address: address, KeyFp: fp, Issuer: s.cfg.URL, Kid: kid,
		Iat: t.UnixMilli(), Exp: t.Add(proto.CertTTL).UnixMilli()}
	proto.SignCert(c, priv)
	return c
}

// ---- HTTP plumbing ----

type apiError struct {
	status int
	code   string
}

func (e *apiError) Error() string { return e.code }

func fail(status int, code string) error { return &apiError{status, code} }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

type handler func(w http.ResponseWriter, r *http.Request, body []byte) error

func (s *Server) wrap(maxBody int64, h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body []byte
		if r.Body != nil {
			var err error
			body, err = io.ReadAll(io.LimitReader(r.Body, maxBody+1))
			if err != nil {
				writeJSON(w, 400, map[string]string{"error": "bad_body"})
				return
			}
			if int64(len(body)) > maxBody {
				writeJSON(w, 413, map[string]string{"error": "too_large"})
				return
			}
		}
		if err := h(w, r, body); err != nil {
			var ae *apiError
			if errors.As(err, &ae) {
				writeJSON(w, ae.status, map[string]string{"error": ae.code})
				return
			}
			log.Printf("%s %s: %v", r.Method, r.URL.Path, err)
			writeJSON(w, 500, map[string]string{"error": "internal"})
		}
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	small := int64(64 << 10)
	envMax := s.cfg.Limits.MaxMailBytes*4/3 + 16<<10
	mux.HandleFunc("GET /.well-known/stem-relay", s.wrap(0, s.wellKnown))
	mux.HandleFunc("GET /v1/info", s.wrap(0, s.info))
	mux.HandleFunc("POST /v1/register", s.wrap(small, s.register))
	mux.HandleFunc("POST /v1/verify", s.wrap(small, s.verify))
	mux.HandleFunc("GET /v1/verify-link", s.wrap(0, s.verifyLinkPage))
	mux.HandleFunc("POST /v1/verify-link", s.wrap(small, s.verifyLink))
	mux.HandleFunc("POST /v1/cert", s.wrap(small, s.cert))
	mux.HandleFunc("GET /v1/keys", s.wrap(0, s.keys))
	mux.HandleFunc("GET /v1/keystatus", s.wrap(0, s.keystatus))
	mux.HandleFunc("POST /v1/mail", s.limited(s.mailSlots, s.wrap(envMax, s.postMail)))
	mux.HandleFunc("GET /v1/mail/status", s.wrap(0, s.mailStatus))
	mux.HandleFunc("GET /v1/stream", s.stream)
	mux.HandleFunc("POST /v1/ack", s.wrap(small, s.ack))
	mux.HandleFunc("POST /v1/allow", s.wrap(small, s.listOp("allow")))
	mux.HandleFunc("POST /v1/unallow", s.wrap(small, s.listOp("unallow")))
	mux.HandleFunc("POST /v1/block", s.wrap(small, s.listOp("block")))
	mux.HandleFunc("POST /v1/unblock", s.wrap(small, s.listOp("unblock")))
	mux.HandleFunc("PUT /v1/account", s.wrap(small, s.account))
	mux.HandleFunc("POST /v1/invite", s.wrap(small, s.invite))
	mux.HandleFunc("POST /v1/revoke", s.wrap(small, s.revoke))
	mux.HandleFunc("GET /v1/unsubscribe", s.wrap(0, s.unsubscribePage))
	mux.HandleFunc("POST /v1/unsubscribe", s.wrap(small, s.unsubscribe))
	mux.HandleFunc("POST /v1/hooks/mail-event", s.wrap(small, s.mailEvent))
	mux.HandleFunc("POST /v1/push", s.wrap(small, s.push))
	mux.HandleFunc("POST /v1/shares", s.limited(s.mailSlots, s.wrap(s.cfg.Share.MaxBytes, s.postShare)))
	mux.HandleFunc("GET /v1/shares", s.wrap(0, s.listShares))
	mux.HandleFunc("GET /v1/shares/{id}", s.wrap(0, s.getShare))
	mux.HandleFunc("DELETE /v1/shares/{id}", s.wrap(0, s.deleteShare))
	mux.HandleFunc("POST /v1/shares/{id}/report", s.wrap(small, s.reportShare))
	mux.HandleFunc("POST /v1/shares/{id}/code", s.wrap(small, s.shareCode))
	mux.HandleFunc("POST /v1/shares/{id}/unlock", s.wrap(small, s.shareUnlock))
	mux.HandleFunc("GET /s/{id}", s.wrap(0, s.sharePage))
	mux.HandleFunc("GET /assets/", s.viewerAsset)
	mux.HandleFunc("GET /og.png", s.viewerAsset)
	mux.HandleFunc("GET /favicon.png", s.viewerAsset)
	return mux
}

// limited caps concurrent requests to a handler: POST /v1/mail is
// unauthenticated until its envelope verifies and reads up to the mail size
// limit into memory.
//
// One client can't hog the slots: at most perIP at a time from one address,
// and the body must arrive within mailReadDeadline, so slow uploads give
// their slot back quickly.
func (s *Server) limited(slots chan struct{}, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := ipBucket(s.clientIP(r))
		if !s.ipSlots.take(ip, perIPMail) {
			writeJSON(w, 429, map[string]string{"error": "rate_limited"})
			return
		}
		defer s.ipSlots.give(ip)
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(mailReadDeadline))
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
			h(w, r)
		case <-time.After(5 * time.Second):
			writeJSON(w, 503, map[string]string{"error": "busy"})
		}
	}
}

const (
	perIPMail        = 4
	mailReadDeadline = 30 * time.Second
	streamsPerKey    = 5
)

// counted is a concurrency counter per key (client IP, account).
type counted struct {
	mu sync.Mutex
	n  map[string]int
}

func (c *counted) take(k string, max int) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.n == nil {
		c.n = map[string]int{}
	}
	if c.n[k] >= max {
		return false
	}
	c.n[k]++
	return true
}

func (c *counted) give(k string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.n[k]--; c.n[k] <= 0 {
		delete(c.n, k)
	}
}

// ipBucket is what per-IP limits count: the address itself for IPv4, its
// /64 for IPv6, since one client holds a whole /64 and can rotate through it.
func ipBucket(ip string) string {
	a, err := netip.ParseAddr(ip)
	if err != nil || a.Unmap().Is4() {
		return ip
	}
	p, _ := a.Prefix(64)
	return p.String()
}

func (s *Server) clientIP(r *http.Request) string {
	if s.cfg.TrustProxy {
		// The rightmost entry is the one our own proxy appended; anything
		// left of it came from the client and could be forged.
		if xff := r.Header.Values("X-Forwarded-For"); len(xff) > 0 {
			parts := strings.Split(xff[len(xff)-1], ",")
			if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// signed verifies the Stem-* request headers and returns the key.
func (s *Server) signed(r *http.Request, body []byte) (ed25519.PublicKey, error) {
	pub, err := proto.VerifyRequest(r.Header.Get("Stem-Key"), r.Header.Get("Stem-Time"), r.Header.Get("Stem-Sig"),
		r.Method, r.URL.RequestURI(), body, s.Now())
	if err != nil {
		return nil, fail(401, "bad_signature")
	}
	return pub, nil
}

// own verifies a signed request from a key registered here.
func (s *Server) own(r *http.Request, body []byte) (*store.Account, []string, error) {
	pub, err := s.signed(r, body)
	if err != nil {
		return nil, nil, err
	}
	acc, err := s.st.Account(proto.Fingerprint(pub))
	if errors.Is(err, store.ErrNotFound) || err == nil && acc.Revoked {
		return nil, nil, fail(403, "not_registered")
	} else if err != nil {
		return nil, nil, err
	}
	addrs, err := s.st.AccountAddresses(acc.Fp)
	return acc, addrs, err
}

// certified verifies a signed request carrying Stem-Cert and returns the
// certified address and the key's fingerprint.
func (s *Server) certified(r *http.Request, body []byte) (string, string, error) {
	pub, err := s.signed(r, body)
	if err != nil {
		return "", "", err
	}
	raw, err := proto.UnB64(r.Header.Get("Stem-Cert"))
	if err != nil {
		return "", "", fail(401, "bad_certificate")
	}
	var c proto.Cert
	if json.Unmarshal(raw, &c) != nil {
		return "", "", fail(401, "bad_certificate")
	}
	if err := proto.VerifyCert(&c, s.Now(), s.issuerKeys); err != nil {
		if errors.Is(err, errOutsider) {
			return "", "", errOutsider
		}
		return "", "", fail(401, "bad_certificate")
	}
	fp := proto.Fingerprint(pub)
	if c.KeyFp != fp {
		return "", "", fail(401, "bad_certificate")
	}
	if sus, err := s.st.Suspended(c.Address); err != nil {
		return "", "", err
	} else if sus {
		return "", "", fail(403, "suspended")
	}
	return c.Address, fp, nil
}

func decode(body []byte, v any) error {
	if err := json.Unmarshal(body, v); err != nil {
		return fail(400, "bad_json")
	}
	return nil
}

func addressArg(a string) (string, error) {
	a = proto.NormalizeAddress(a)
	if !proto.ValidAddress(a) {
		return "", fail(400, "bad_address")
	}
	return a, nil
}

func (s *Server) hit(k string, window time.Duration, limit int) (bool, error) {
	return s.st.Hit(k, window, limit)
}

const day = 24 * time.Hour

// ---- discovery ----

func (s *Server) wellKnown(w http.ResponseWriter, r *http.Request, _ []byte) error {
	type key struct {
		Kid string `json:"kid"`
		Pub string `json:"pub"`
	}
	var keys []key
	for kid, pub := range s.PublicKeys() {
		keys = append(keys, key{kid, proto.B64(pub)})
	}
	slices.SortFunc(keys, func(a, b key) int { return strings.Compare(a.Kid, b.Kid) })
	writeJSON(w, 200, map[string]any{"v": 1, "url": s.cfg.URL, "global": s.cfg.Global, "keys": keys})
	return nil
}

func (s *Server) info(w http.ResponseWriter, r *http.Request, _ []byte) error {
	features := []string{"pow", "unlisted", "status"}
	if s.cfg.Invite.Enabled {
		features = append(features, "invites")
	}
	if s.Pusher != nil {
		features = append(features, "push")
	}
	l := s.cfg.Limits
	limits := map[string]any{"maxMailBytes": l.MaxMailBytes, "powBits": l.PowBits, "holdDays": l.HoldDays}
	if s.cfg.Share.Enabled {
		features = append(features, "share", "share-to")
		limits["maxShareBytes"] = s.cfg.Share.MaxBytes
		limits["maxShareTtlDays"] = s.cfg.Share.MaxTTLDays
	}
	writeJSON(w, 200, map[string]any{"v": 1, "version": Version, "features": features, "limits": limits})
	return nil
}

// ---- register / verify ----

func randomDigits(n int) string {
	var b strings.Builder
	for range n {
		d, _ := rand.Int(rand.Reader, big.NewInt(10))
		b.WriteByte(byte('0' + d.Int64()))
	}
	return b.String()
}

func randomToken() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return strings.TrimRight(strings.NewReplacer("+", "-", "/", "_").Replace(proto.B64(b)), "=")
}

func codeHash(code, address, fp string) string {
	return proto.SHA256Hex([]byte("stem-code-v1\n" + code + "\n" + address + "\n" + fp))
}

func (s *Server) register(w http.ResponseWriter, r *http.Request, body []byte) error {
	pub, err := s.signed(r, body)
	if err != nil {
		return err
	}
	var in struct {
		Address string `json:"address"`
		KeyBlob string `json:"keyBlob"`
		Pow     struct {
			Nonce string `json:"nonce"`
		} `json:"pow"`
	}
	if err := decode(body, &in); err != nil {
		return err
	}
	addr, err := addressArg(in.Address)
	if err != nil {
		return err
	}
	if in.KeyBlob == "" || len(in.KeyBlob) > 8<<10 {
		return fail(400, "bad_key_blob")
	}
	if ok, err := s.Serves(addr); err != nil {
		return err
	} else if !ok {
		return fail(421, "not_authoritative")
	}
	keyB64 := r.Header.Get("Stem-Key")
	if !proto.PowOK(addr, keyB64, in.Pow.Nonce, s.cfg.Limits.PowBits) {
		return fail(400, "bad_pow")
	}
	fp := proto.Fingerprint(pub)
	l := s.cfg.Limits
	for _, c := range []struct {
		k string
		n int
	}{{"code:addr:" + addr, l.CodesPerAddressDay}, {"code:key:" + fp, l.CodesPerKeyDay}, {"code:ip:" + ipBucket(s.clientIP(r)), l.CodesPerIPDay}} {
		if ok, err := s.hit(c.k, day, c.n); err != nil {
			return err
		} else if !ok {
			return fail(429, "rate_limited")
		}
	}
	resp := map[string]string{"status": "code_sent"}
	if sup, err := s.st.Suppressed(addr); err != nil {
		return err
	} else if sup {
		writeJSON(w, 202, resp)
		return nil
	}
	code, token := randomDigits(6), randomToken()
	if err := s.st.PutPending(store.Pending{Address: addr, Fp: fp, AuthKey: keyB64, KeyBlob: in.KeyBlob,
		CodeHash: codeHash(code, addr, fp), Token: token}); err != nil {
		return err
	}
	unsub := randomToken()
	if err := s.st.PutUnsubToken(unsub, addr); err != nil {
		return err
	}
	holder, _, err := s.st.AddressAccount(addr)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	link := s.cfg.URL + "/v1/verify-link?t=" + token
	stop := s.cfg.URL + "/v1/unsubscribe?t=" + unsub
	var subject, text string
	if holder != nil && holder.Fp != fp {
		subject = "A new device wants to use this address in Stem"
		text = fmt.Sprintf("Someone asked to connect %s to a new Stem.\n\nIf that was you (for example on a new computer), your code is %s, or open:\n%s\n\nIf it wasn't you, ignore this email; nothing changes unless the code is used.\n\nNever email me again: %s\n", addr, code, link, stop)
	} else {
		subject = "Your Stem code: " + code
		text = fmt.Sprintf("Your code to connect %s to Stem is %s.\n\nOr open: %s\n\nIf you didn't ask for this, ignore this email.\nThis wasn't me, never email me again: %s\n", addr, code, link, stop)
	}
	if err := s.mail.Send(mailer.Message{Kind: mailer.Verify, To: addr, Subject: subject, Body: text, Tag: "v-" + token[:12]}); err != nil {
		log.Printf("verification mail to %s failed: %v", addr, err)
	}
	writeJSON(w, 202, resp)
	return nil
}

func (s *Server) verify(w http.ResponseWriter, r *http.Request, body []byte) error {
	pub, err := s.signed(r, body)
	if err != nil {
		return err
	}
	var in struct{ Address, Code string }
	if err := decode(body, &in); err != nil {
		return err
	}
	addr, err := addressArg(in.Address)
	if err != nil {
		return err
	}
	fp := proto.Fingerprint(pub)
	p, err := s.st.GetPending(addr, fp)
	if errors.Is(err, store.ErrNotFound) {
		return fail(400, "invalid_code")
	} else if err != nil {
		return err
	}
	// Spend the attempt before comparing, atomically, so parallel guesses
	// can't each see attempts < 5.
	if ok, err := s.st.TakePendingAttempt(addr, fp, 5); err != nil {
		return err
	} else if !ok {
		return fail(400, "invalid_code")
	}
	if subtle.ConstantTimeCompare([]byte(codeHash(strings.TrimSpace(in.Code), addr, fp)), []byte(p.CodeHash)) != 1 {
		return fail(400, "invalid_code")
	}
	if err := s.st.CompleteVerification(p); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"cert": s.issueCert(addr, fp)})
	return nil
}

// page renders a minimal HTML page. form, when set, adds a POST button
// carrying the token: links in emails only ever show a page, because mail
// scanners and link previews open every link they see.
func page(w http.ResponseWriter, status int, title, text string, form ...string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>%s</title>
<body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.4rem">%s</h1><p>%s</p>`,
		html.EscapeString(title), html.EscapeString(title), html.EscapeString(text))
	if len(form) == 3 {
		fmt.Fprintf(w, `<form method="post" action="%s"><input type="hidden" name="t" value="%s"><button style="font:inherit;padding:.5rem 1rem">%s</button></form>`,
			html.EscapeString(form[0]), html.EscapeString(form[1]), html.EscapeString(form[2]))
	}
	fmt.Fprint(w, `</body>`)
}

func formToken(r *http.Request, body []byte) string {
	v, err := url.ParseQuery(string(body))
	if err != nil {
		return ""
	}
	return v.Get("t")
}

func (s *Server) verifyLinkPage(w http.ResponseWriter, r *http.Request, _ []byte) error {
	t := r.URL.Query().Get("t")
	p, err := s.st.GetPendingByToken(t)
	if errors.Is(err, store.ErrNotFound) {
		page(w, 404, "Link expired", "This link was already used or has expired. Ask Stem for a new code.")
		return nil
	} else if err != nil {
		return err
	}
	text := "Connect " + p.Address + " to the Stem that asked for it?"
	if holder, _, err := s.st.AddressAccount(p.Address); err == nil && holder.Fp != p.Fp {
		text = "This connects " + p.Address + " to a NEW device. The Stem using it now stops receiving its mail. Only continue if you asked for this."
	}
	page(w, 200, "Confirm your address", text, "/v1/verify-link", t, "Confirm")
	return nil
}

func (s *Server) verifyLink(w http.ResponseWriter, r *http.Request, body []byte) error {
	p, err := s.st.GetPendingByToken(formToken(r, body))
	if errors.Is(err, store.ErrNotFound) {
		page(w, 404, "Link expired", "This link was already used or has expired. Ask Stem for a new code.")
		return nil
	} else if err != nil {
		return err
	}
	if err := s.st.CompleteVerification(p); err != nil {
		return err
	}
	page(w, 200, "Address confirmed", "You can go back to Stem.")
	return nil
}

func (s *Server) cert(w http.ResponseWriter, r *http.Request, body []byte) error {
	acc, addrs, err := s.own(r, body)
	if err != nil {
		return err
	}
	var in struct{ Address string }
	if err := decode(body, &in); err != nil {
		return err
	}
	addr := proto.NormalizeAddress(in.Address)
	if !slices.Contains(addrs, addr) {
		return fail(403, "not_your_address")
	}
	writeJSON(w, 200, map[string]any{"cert": s.issueCert(addr, acc.Fp)})
	return nil
}

func (s *Server) revoke(w http.ResponseWriter, r *http.Request, body []byte) error {
	acc, _, err := s.own(r, body)
	if err != nil {
		return err
	}
	if err := s.st.Revoke(acc.Fp); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{})
	return nil
}

// ---- lookups ----

var errNotReachable = fail(404, "not_reachable")

func (s *Server) keys(w http.ResponseWriter, r *http.Request, body []byte) error {
	requester, _, err := s.certified(r, body)
	if errors.Is(err, errOutsider) {
		// Same answer as an unknown address: outsiders can't list who is here.
		return errNotReachable
	} else if err != nil {
		return err
	}
	l := s.cfg.Limits
	if ok, err := s.hit("lookup:min:"+requester, time.Minute, l.LookupBurst); err != nil {
		return err
	} else if !ok {
		return fail(429, "rate_limited")
	}
	if ok, err := s.hit("lookup:day:"+requester, day, l.LookupsPerDay); err != nil {
		return err
	} else if !ok {
		return fail(429, "rate_limited")
	}
	target, err := addressArg(r.URL.Query().Get("address"))
	if err != nil {
		return err
	}
	if ok, err := s.Serves(target); err != nil {
		return err
	} else if !ok {
		return fail(421, "not_authoritative")
	}
	acc, _, err := s.st.AddressAccount(target)
	if errors.Is(err, store.ErrNotFound) || err == nil && acc.Revoked {
		return errNotReachable
	} else if err != nil {
		return err
	}
	if sus, err := s.st.Suspended(target); err != nil {
		return err
	} else if sus {
		return errNotReachable
	}
	if acc.Unlisted {
		if ok, err := s.st.Allows(acc.Fp, requester); err != nil {
			return err
		} else if !ok {
			return errNotReachable
		}
	}
	writeJSON(w, 200, map[string]string{"authKey": acc.AuthKey, "keyBlob": acc.KeyBlob})
	return nil
}

func (s *Server) keystatus(w http.ResponseWriter, r *http.Request, _ []byte) error {
	q := r.URL.Query()
	addr := proto.NormalizeAddress(q.Get("address"))
	acc, _, err := s.st.AddressAccount(addr)
	current := err == nil && !acc.Revoked && acc.Fp == q.Get("fp")
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	writeJSON(w, 200, map[string]bool{"current": current})
	return nil
}

// ---- lists and account ----

func (s *Server) listOp(op string) handler {
	return func(w http.ResponseWriter, r *http.Request, body []byte) error {
		acc, addrs, err := s.own(r, body)
		if err != nil {
			return err
		}
		var in struct{ Address string }
		if err := decode(body, &in); err != nil {
			return err
		}
		addr, err := addressArg(in.Address)
		if err != nil {
			return err
		}
		switch op {
		case "allow":
			err = s.st.Allow(acc.Fp, addr)
			for _, own := range addrs {
				if err == nil {
					err = s.st.ClearKnock(addr, own)
				}
			}
		case "unallow":
			err = s.st.Unallow(acc.Fp, addr)
		case "block":
			if err = s.st.Block(acc.Fp, addr); err == nil {
				err = s.maybeSuspend(addr)
			}
		case "unblock":
			err = s.st.Unblock(acc.Fp, addr)
		}
		if err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{})
		return nil
	}
}

func (s *Server) maybeSuspend(addr string) error {
	l := s.cfg.Limits
	if l.BlockSuspendCount <= 0 {
		return nil
	}
	since := s.Now().Add(-time.Duration(l.BlockSuspendWindowHr) * time.Hour).UnixMilli()
	n, err := s.st.DistinctBlockers(addr, since)
	if err != nil || n < l.BlockSuspendCount {
		return err
	}
	log.Printf("suspending %s: blocked by %d accounts", addr, n)
	return s.st.Suspend(addr)
}

func (s *Server) account(w http.ResponseWriter, r *http.Request, body []byte) error {
	acc, _, err := s.own(r, body)
	if err != nil {
		return err
	}
	var in struct {
		Unlisted *bool `json:"unlisted"`
	}
	if err := decode(body, &in); err != nil {
		return err
	}
	if in.Unlisted != nil {
		if err := s.st.SetUnlisted(acc.Fp, *in.Unlisted); err != nil {
			return err
		}
		acc.Unlisted = *in.Unlisted
	}
	writeJSON(w, 200, map[string]any{"unlisted": acc.Unlisted})
	return nil
}

func (s *Server) unsubscribePage(w http.ResponseWriter, r *http.Request, _ []byte) error {
	t := r.URL.Query().Get("t")
	addr, err := s.st.UnsubToken(t)
	if errors.Is(err, store.ErrNotFound) {
		page(w, 404, "Link not recognised", "This link is invalid.")
		return nil
	} else if err != nil {
		return err
	}
	page(w, 200, "Stop all email from this relay?", "This relay will never email "+addr+" again, including codes to connect it to Stem, until it is connected from that address.", "/v1/unsubscribe", t, "Stop emailing me")
	return nil
}

func (s *Server) unsubscribe(w http.ResponseWriter, r *http.Request, body []byte) error {
	addr, err := s.st.UnsubToken(formToken(r, body))
	if errors.Is(err, store.ErrNotFound) {
		page(w, 404, "Link not recognised", "This link is invalid.")
		return nil
	} else if err != nil {
		return err
	}
	if err := s.st.Suppress(addr); err != nil {
		return err
	}
	page(w, 200, "You won't hear from us again", "This relay will not email "+addr+" again.")
	return nil
}
