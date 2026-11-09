// Package config is the relay's TOML config. Every abuse number lives
// here, so tuning a relay is a config edit, never a release.
package config

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/BurntSushi/toml"

	"github.com/join3r/stem/relay/internal/proto"
)

type Config struct {
	// Public base URL of this relay, e.g. https://relay.stem.example.
	URL string `toml:"url"`
	// Global is true only for the global relay: it serves every domain
	// without a _stem record. A private relay sets Domains instead.
	Global  bool     `toml:"global"`
	Domains []string `toml:"domains"`
	// The global relay's URL and keys ("kid:<b64>"), so a private relay can
	// check certificates for addresses on the global relay.
	GlobalURL  string   `toml:"global_url"`
	GlobalKeys []string `toml:"global_keys"`
	// Closed (private relays only): only addresses in Domains and
	// PartnerDomains may mail this relay's people or look up their keys.
	// Everyone else, the global relay's users included, is turned away.
	// Publish the record with access=closed too (stem-relay dns does), so
	// other relays refuse this relay's people as senders.
	Closed         bool     `toml:"closed"`
	PartnerDomains []string `toml:"partner_domains"`

	DataDir string `toml:"data_dir"`

	Listen  string `toml:"listen"`   // plain HTTP, e.g. ":8080" behind a proxy
	TLS     bool   `toml:"tls"`      // built-in Let's Encrypt on :443
	TLSHost string `toml:"tls_host"` // hostname for the certificate
	// Trust X-Forwarded-For (only behind your own reverse proxy).
	TrustProxy bool `toml:"trust_proxy"`

	Mail   Mail   `toml:"mail"`
	Limits Limits `toml:"limits"`
	Invite Invite `toml:"invites"`
	Push   Push   `toml:"push"`
	Share  Share  `toml:"share"`
}

// Share hosts public share links: blobs a Stem encrypted before upload, so
// the relay never sees what is in them. The global relay only.
type Share struct {
	Enabled bool `toml:"enabled"`
	// Public base of the viewer, e.g. https://share.heystem.app; a link is
	// <viewer_url>/s/<id>#<key>.
	ViewerURL string `toml:"viewer_url"`
	// The viewer build (dist/share). Its index.html is served for /s/<id>
	// with that share's link-preview tags filled in; empty = no previews.
	ViewerDir string `toml:"viewer_dir"`
	// Largest blob, in bytes.
	MaxBytes int64 `toml:"max_bytes"`
	// Shares per certified address per day, live shares it may hold at once,
	// and bytes it may keep stored.
	PerAddressDay int   `toml:"per_address_day"`
	MaxLive       int   `toml:"max_live"`
	QuotaBytes    int64 `toml:"quota_bytes"`
	// Longest expiry a Stem may ask for, in days (also the default). 0 lets a
	// share never expire; the global relay keeps it short so it is no free
	// permanent host.
	MaxTTLDays int `toml:"max_ttl_days"`
	// Abuse reports per client IP per hour.
	ReportsPerIPHour int `toml:"reports_per_ip_hour"`
	// Recipient-locked links: the most recipients per share, codes mailed to
	// one address per share per day (five times that over all shares), code
	// requests per client IP per day, and days a browser that entered a code
	// keeps access.
	MaxRecipients        int `toml:"max_recipients"`
	CodesPerRecipientDay int `toml:"codes_per_recipient_day"`
	CodesPerIPDay        int `toml:"codes_per_ip_day"`
	ViewDays             int `toml:"view_days"`
}

// Push is the APNs gateway: Stems without the app's APNs key send wake-ups
// here, and the relay signs them with its .p8.
type Push struct {
	Enabled  bool   `toml:"enabled"`
	KeyPath  string `toml:"key_path"`
	KeyID    string `toml:"key_id"`
	TeamID   string `toml:"team_id"`
	BundleID string `toml:"bundle_id"`
	// Wake-ups per client IP, per Stem key, per device token, and in all, per hour.
	PerIPHour    int `toml:"per_ip_hour"`
	PerKeyHour   int `toml:"per_key_hour"`
	PerTokenHour int `toml:"per_token_hour"`
	GlobalHour   int `toml:"global_hour"`
	// A token belongs to the first Stem key that pushes to it; another key
	// may take it over only after the owner has been silent this long.
	RebindDays int `toml:"rebind_days"`
}

type Mail struct {
	// "log" prints mail to stderr (development); "smtp" sends it.
	Driver   string `toml:"driver"`
	SMTPHost string `toml:"smtp_host"`
	SMTPPort int    `toml:"smtp_port"`
	SMTPUser string `toml:"smtp_user"`
	SMTPPass string `toml:"smtp_pass"`
	// Separate senders so an invite blocklisting never touches
	// verification mail.
	VerifyFrom string `toml:"verify_from"`
	InviteFrom string `toml:"invite_from"`
	// Optional extra header for the provider's stream selection
	// (e.g. Postmark's X-PM-Message-Stream).
	VerifyStreamHeader string `toml:"verify_stream_header"`
	InviteStreamHeader string `toml:"invite_stream_header"`
}

type Limits struct {
	PowBits              int   `toml:"pow_bits"`
	CodesPerAddressDay   int   `toml:"codes_per_address_day"`
	CodesPerKeyDay       int   `toml:"codes_per_key_day"`
	CodesPerIPDay        int   `toml:"codes_per_ip_day"`
	FirstContactsPerDay  int   `toml:"first_contacts_per_day"`
	MailsPerSenderHour   int   `toml:"mails_per_sender_hour"`
	MailsPerIssuerHour   int   `toml:"mails_per_issuer_hour"`
	NewAddressDays       int   `toml:"new_address_days"`
	NewAddressDivisor    int   `toml:"new_address_divisor"`
	MaxMailBytes         int64 `toml:"max_mail_bytes"`
	QueueBytes           int64 `toml:"queue_bytes"`
	QueueMails           int   `toml:"queue_mails"`
	QueueSenderShare     int   `toml:"queue_sender_share_percent"`
	HoldDays             int   `toml:"hold_days"`
	KnockDays            int   `toml:"knock_days"`
	LookupsPerDay        int   `toml:"lookups_per_day"`
	LookupBurst          int   `toml:"lookup_burst"`
	BlockSuspendCount    int   `toml:"block_suspend_count"`
	BlockSuspendWindowHr int   `toml:"block_suspend_window_hours"`
}

type Invite struct {
	Enabled           bool    `toml:"enabled"`
	PerRecipientDays  int     `toml:"per_recipient_days"`
	MaxPerRecipient   int     `toml:"max_per_recipient"`
	PerSenderDay      int     `toml:"per_sender_day"`
	PerSenderMonth    int     `toml:"per_sender_month"`
	GlobalPerDay      int     `toml:"global_per_day"`
	BounceRatePct     float64 `toml:"breaker_bounce_percent"`
	ComplaintRatePct  float64 `toml:"breaker_complaint_percent"`
	BreakerWindowDays int     `toml:"breaker_window_days"`
	BreakerMinSample  int     `toml:"breaker_min_sample"`
	WebhookSecret     string  `toml:"webhook_secret"`
	DownloadURL       string  `toml:"download_url"`
}

func Defaults() Config {
	return Config{
		Listen:  ":8080",
		DataDir: "./data",
		Mail:    Mail{Driver: "log"},
		Limits: Limits{
			PowBits: 20, CodesPerAddressDay: 3, CodesPerKeyDay: 10, CodesPerIPDay: 20,
			FirstContactsPerDay: 20, MailsPerSenderHour: 200, MailsPerIssuerHour: 20000,
			NewAddressDays: 7, NewAddressDivisor: 4,
			MaxMailBytes: 25 << 20, QueueBytes: 200 << 20, QueueMails: 1000, QueueSenderShare: 25,
			HoldDays: 7, KnockDays: 30, LookupsPerDay: 100, LookupBurst: 20,
			BlockSuspendCount: 10, BlockSuspendWindowHr: 24,
		},
		Invite: Invite{
			PerRecipientDays: 30, MaxPerRecipient: 3, PerSenderDay: 5, PerSenderMonth: 20,
			GlobalPerDay: 200, BounceRatePct: 2, ComplaintRatePct: 0.1, BreakerWindowDays: 7,
			BreakerMinSample: 50,
		},
		Push: Push{PerIPHour: 600, PerKeyHour: 120, PerTokenHour: 60, GlobalHour: 20000, RebindDays: 7},
		Share: Share{MaxBytes: 12 << 20, PerAddressDay: 30, MaxLive: 100, QuotaBytes: 500 << 20, MaxTTLDays: 30,
			ReportsPerIPHour: 20, MaxRecipients: 20, CodesPerRecipientDay: 10, CodesPerIPDay: 30, ViewDays: 7},
	}
}

func Load(path string) (*Config, error) {
	c := Defaults()
	if _, err := toml.DecodeFile(path, &c); err != nil {
		return nil, err
	}
	return &c, c.Validate()
}

func (c *Config) Validate() error {
	c.URL = strings.TrimRight(c.URL, "/")
	if c.URL == "" {
		return errors.New("url is required")
	}
	if !c.Global && len(c.Domains) == 0 {
		return errors.New("a private relay needs domains")
	}
	if c.Global && c.Closed {
		return errors.New("the global relay can't be closed")
	}
	if !c.Closed && len(c.PartnerDomains) > 0 {
		return errors.New("partner_domains only applies to a closed relay")
	}
	if c.Global {
		c.GlobalURL = c.URL
	} else if !c.Closed && (c.GlobalURL == "" || len(c.GlobalKeys) == 0) {
		return errors.New("a private relay needs global_url and global_keys to accept mail from the global relay's users (or closed = true)")
	}
	if p := c.Push; p.Enabled && (p.KeyPath == "" || p.KeyID == "" || p.TeamID == "" || p.BundleID == "") {
		return errors.New("[push] needs key_path, key_id, team_id and bundle_id")
	}
	if c.Share.Enabled {
		if !c.Global {
			return errors.New("[share] runs on the global relay only")
		}
		c.Share.ViewerURL = strings.TrimRight(c.Share.ViewerURL, "/")
		if !strings.HasPrefix(c.Share.ViewerURL, "https://") && !strings.HasPrefix(c.Share.ViewerURL, "http://") {
			return errors.New("[share] needs viewer_url")
		}
	}
	for i, d := range c.Domains {
		c.Domains[i] = strings.ToLower(strings.TrimSpace(d))
	}
	for i, d := range c.PartnerDomains {
		c.PartnerDomains[i] = strings.ToLower(strings.TrimSpace(d))
	}
	return nil
}

// ParseKeys parses "kid:<b64>" entries.
func ParseKeys(entries []string) (map[string]ed25519.PublicKey, error) {
	out := map[string]ed25519.PublicKey{}
	for _, e := range entries {
		kid, pub, ok := strings.Cut(e, ":")
		if !ok {
			return nil, fmt.Errorf("bad key entry %q", e)
		}
		k, err := proto.ParseEd25519(pub)
		if err != nil {
			return nil, fmt.Errorf("key %s: %w", kid, err)
		}
		out[kid] = k
	}
	return out, nil
}

func (c *Config) Write(path string) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	return toml.NewEncoder(f).Encode(c)
}
