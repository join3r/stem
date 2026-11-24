package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"testing"
)

func toParam(addrs ...string) string {
	b, _ := json.Marshal(addrs)
	return base64.RawURLEncoding.EncodeToString(b)
}

// browser is a visitor with its own cookies.
type browser struct {
	t *testing.T
	c *http.Client
}

func newBrowser(t *testing.T) *browser {
	jar, _ := cookiejar.New(nil)
	return &browser{t, &http.Client{Jar: jar}}
}

func (b *browser) get(url string) (int, []byte) {
	b.t.Helper()
	resp, err := b.c.Get(url)
	if err != nil {
		b.t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

func (b *browser) post(url, body string) (int, []byte) {
	b.t.Helper()
	resp, err := b.c.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		b.t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

func TestLockedShareLinks(t *testing.T) {
	w := newWorld(t)
	g := w.global
	a := w.newStem(g, "a@gmail.test")
	a.register()
	g.srv.cfg.Share.Enabled = true
	g.srv.cfg.Share.ViewerURL = "https://share.example"

	// Bad recipient lists are refused, not turned into a public link.
	for _, to := range []string{"!!", toParam(), toParam("not an address")} {
		if code, out := a.doRaw(g.http.URL, "POST", "/v1/shares?to="+to, blob(64), true); code != 400 {
			t.Fatalf("to=%q answered %d %s", to, code, out)
		}
	}
	g.srv.cfg.Share.MaxRecipients = 2
	if code, _ := a.doRaw(g.http.URL, "POST", "/v1/shares?to="+toParam("x@x.test", "y@y.test", "z@z.test"), blob(64), true); code != 400 {
		t.Fatalf("too many recipients answered %d", code)
	}

	code, out := a.doRaw(g.http.URL, "POST", "/v1/shares?to="+toParam("Martin@Gmail.test", "martin@gmail.test", "eva@mail.test"), blob(64), true)
	if code != 200 {
		t.Fatalf("locked upload: %d %s", code, out)
	}
	var made struct {
		ID         string   `json:"id"`
		Recipients []string `json:"recipients"`
	}
	_ = json.Unmarshal(out, &made)
	if strings.Join(made.Recipients, ",") != "martin@gmail.test,eva@mail.test" {
		t.Fatalf("upload must echo the normalised recipients: %s", out)
	}
	base := g.http.URL + "/v1/shares/" + made.ID

	// Without a code: locked, with masked addresses only.
	v := newBrowser(t)
	code, out = v.get(base)
	if code != 401 || !strings.Contains(string(out), `"m•••@gmail.test"`) || strings.Contains(string(out), "martin@") {
		t.Fatalf("locked fetch: %d %s", code, out)
	}

	// A code goes to the picked recipient only, and only once a minute.
	before := len(g.mail.Messages())
	if code, out := v.post(base+"/code", `{"r":0}`); code != 202 {
		t.Fatalf("code: %d %s", code, out)
	}
	msgs := g.mail.Messages()[before:]
	if len(msgs) != 1 || msgs[0].To != "martin@gmail.test" || !strings.Contains(msgs[0].Body, "a@gmail.test shared a page") {
		t.Fatalf("code mail: %+v", msgs)
	}
	if code, _ := v.post(base+"/code", `{"r":0}`); code != 429 {
		t.Fatalf("second code within a minute answered %d", code)
	}
	if code, _ := v.post(base+"/code", `{"r":5}`); code != 400 {
		t.Fatalf("bad index answered %d", code)
	}

	// A wrong code fails; the right one sets the cookie and opens the blob.
	if code, _ := v.post(base+"/unlock", `{"r":0,"code":"000000x"}`); code != 403 {
		t.Fatalf("wrong code answered %d", code)
	}
	right := lastCode(t, g.mail, "martin@gmail.test")
	if code, _ := v.post(base+"/unlock", `{"r":1,"code":"`+right+`"}`); code != 403 {
		t.Fatalf("martin's code for eva answered %d", code)
	}
	if code, out := v.post(base+"/unlock", `{"r":0,"code":"`+right+`"}`); code != 200 {
		t.Fatalf("unlock: %d %s", code, out)
	}
	if code, _ := v.post(base+"/unlock", `{"r":0,"code":"`+right+`"}`); code != 403 {
		t.Fatalf("a used code answered %d", code)
	}
	code, got := v.get(base)
	if code != 200 || !bytes.Equal(got, blob(64)) {
		t.Fatalf("unlocked fetch: %d %s", code, got)
	}
	v.get(base)

	// Another browser with the same link is still locked.
	if code, _ := newBrowser(t).get(base); code != 401 {
		t.Fatalf("other browser answered %d", code)
	}

	// The owner sees recipients and who opened, how often.
	_, out = a.do(g.http.URL, "GET", "/v1/shares", nil, true)
	var list struct {
		Shares []struct {
			ID         string   `json:"id"`
			Recipients []string `json:"recipients"`
			Opens      []struct {
				Address string `json:"address"`
				First   int64  `json:"first"`
				Count   int    `json:"count"`
			} `json:"opens"`
		} `json:"shares"`
	}
	_ = json.Unmarshal(out, &list)
	if len(list.Shares) != 1 || len(list.Shares[0].Recipients) != 2 || len(list.Shares[0].Opens) != 1 ||
		list.Shares[0].Opens[0].Address != "martin@gmail.test" || list.Shares[0].Opens[0].Count != 2 || list.Shares[0].Opens[0].First == 0 {
		t.Fatalf("list: %s", out)
	}

	// Five wrong codes use a code up.
	if code, _ := v.post(base+"/code", `{"r":1}`); code != 202 {
		t.Fatalf("code for eva answered %d", code)
	}
	eva := lastCode(t, g.mail, "eva@mail.test")
	for range 5 {
		v.post(base+"/unlock", `{"r":1,"code":"999999x"}`)
	}
	if code, _ := v.post(base+"/unlock", `{"r":1,"code":"`+eva+`"}`); code != 403 {
		t.Fatalf("code after five misses answered %d", code)
	}

	// A public share has no code flow.
	code, out = a.doRaw(g.http.URL, "POST", "/v1/shares", blob(64), true)
	var pub struct {
		ID         string   `json:"id"`
		Recipients []string `json:"recipients"`
	}
	_ = json.Unmarshal(out, &pub)
	if code != 200 || pub.Recipients != nil {
		t.Fatalf("public upload: %d %s", code, out)
	}
	if code, _ := v.post(g.http.URL+"/v1/shares/"+pub.ID+"/code", `{"r":0}`); code != 400 {
		t.Fatalf("code on a public share answered %d", code)
	}

	// Revoke: the unlocked browser is shut out too.
	if code, _ := a.do(g.http.URL, "DELETE", "/v1/shares/"+made.ID, nil, true); code != 200 {
		t.Fatalf("revoke answered %d", code)
	}
	if code, _ := v.get(base); code != 410 {
		t.Fatalf("revoked locked fetch answered %d", code)
	}
}
