package api

import (
	"cmp"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/git"
	"github.com/vexdock/platform/manager/internal/security"
)

// Connecting a GitHub App is three redirects rather than a form. The dashboard
// asks for a manifest and posts it to GitHub, GitHub creates the app and comes
// back with a one-time code, and the owner then installs that app on the
// repositories it may reach, all of them or the few they pick. Nothing is typed
// by hand and nothing but the app's own key is stored.

// gitAppStateKey holds the nonce that ties a manifest handed out here to the
// code that comes back. One key, not one per attempt: a second connection
// replaces the first rather than leaving rows behind.
const gitAppStateKey = "github_app_state"

// gitAppStateTTL is how long a started connection stays valid. Long enough to
// read GitHub's confirmation page, short enough that an abandoned attempt
// cannot be finished by a later request.
const gitAppStateTTL = 15 * time.Minute

// gitSettingsPath is where every leg of the flow puts the browser back.
const gitSettingsPath = "/system/settings/git"

// githubLogin bounds the organization name, which ends up in the URL the
// dashboard posts the manifest to.
var githubLogin = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`)

// handleGitAppManifest hands the dashboard the app GitHub should create and the
// URL to post it to. The manifest, not the user, decides the permissions.
func (s *Server) handleGitAppManifest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name         string `json:"name"`
		Organization string `json:"organization"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	public := strings.TrimSuffix(strings.TrimSpace(s.Config.PublicURL), "/")
	if !strings.HasPrefix(public, "https://") {
		badRequest(w, errors.New("GitHub can only reach a panel served over https; set the panel URL first"))
		return
	}
	organization := strings.TrimSpace(req.Organization)
	if organization != "" && !githubLogin.MatchString(organization) {
		badRequest(w, errors.New("that is not a GitHub organization name"))
		return
	}
	name := cmp.Or(strings.TrimSpace(req.Name), "vexdock")

	state := security.RandomToken(24)
	if err := s.DB.SetSetting(r.Context(), gitAppStateKey, state+"|"+strconv.FormatInt(time.Now().Unix(), 10)); err != nil {
		serverError(w, err)
		return
	}
	manifest, err := json.Marshal(git.Manifest(name, public))
	if err != nil {
		serverError(w, err)
		return
	}
	postURL := "https://github.com/settings/apps/new?state=" + url.QueryEscape(state)
	if organization != "" {
		postURL = "https://github.com/organizations/" + organization + "/settings/apps/new?state=" + url.QueryEscape(state)
	}
	writeJSON(w, http.StatusOK, map[string]string{"post_url": postURL, "manifest": string(manifest)})
}

// handleGitAppCallback is where GitHub sends the owner once the app exists. The
// code is exchanged for the app's key, which is stored as an ordinary git
// account, and the browser continues to the install screen where the
// repositories are picked.
func (s *Server) handleGitAppCallback(w http.ResponseWriter, r *http.Request) {
	if !s.consumeGitAppState(r, r.URL.Query().Get("state")) {
		gitAppFailure(w, r, "that connection attempt expired; start it again")
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		gitAppFailure(w, r, "GitHub came back without a code")
		return
	}
	app, err := git.ConvertManifest(r.Context(), code)
	if err != nil {
		gitAppFailure(w, r, err.Error())
		return
	}
	key, err := s.Cipher.Encrypt(app.PrivateKey)
	if err != nil {
		serverError(w, err)
		return
	}
	hookSecret, err := s.Cipher.Encrypt(app.WebhookSecret)
	if err != nil {
		serverError(w, err)
		return
	}
	account := &database.GitAccount{
		Provider:            "github",
		Name:                cmp.Or(app.Name, app.Slug),
		EncryptedTok:        key,
		AppID:               app.ID,
		AppSlug:             app.Slug,
		EncryptedHookSecret: hookSecret,
	}
	if err := s.DB.CreateGitAccount(r.Context(), account); err != nil {
		gitAppFailure(w, r, err.Error())
		return
	}
	// The account id travels as the install state so the installation GitHub
	// reports lands on the app it belongs to.
	http.Redirect(w, r, "https://github.com/apps/"+url.PathEscape(app.Slug)+
		"/installations/new?state="+url.QueryEscape(account.ID), http.StatusFound)
}

// handleGitAppInstalled records which installation an app account clones
// through. GitHub sends the owner here after the first install and after every
// later change to the repository selection.
func (s *Server) handleGitAppInstalled(w http.ResponseWriter, r *http.Request) {
	account, err := s.DB.GitAccount(r.Context(), r.URL.Query().Get("state"))
	if err != nil || account.AppID == "" {
		gitAppFailure(w, r, "that install does not belong to a connected app")
		return
	}
	installation := r.URL.Query().Get("installation_id")
	key, err := s.Cipher.Decrypt(account.EncryptedTok)
	if err != nil {
		serverError(w, err)
		return
	}
	// Minting a token is the proof: only the app the installation belongs to
	// can get one, so a guessed installation id gets nowhere.
	if _, err := git.InstallationToken(r.Context(), account.AppID, installation, key); err != nil {
		gitAppFailure(w, r, err.Error())
		return
	}
	if err := s.DB.SetGitAccountInstallation(r.Context(), account.ID, installation); err != nil {
		serverError(w, err)
		return
	}
	http.Redirect(w, r, gitSettingsPath, http.StatusFound)
}

// consumeGitAppState checks the nonce a redirect came back with and clears it,
// so a code can only be exchanged by the browser that started the connection
// and only once.
func (s *Server) consumeGitAppState(r *http.Request, state string) bool {
	stored := s.setting(r.Context(), gitAppStateKey)
	_ = s.DB.SetSetting(r.Context(), gitAppStateKey, "")
	nonce, issued, ok := strings.Cut(stored, "|")
	if !ok || state == "" || nonce == "" || subtle.ConstantTimeCompare([]byte(nonce), []byte(state)) != 1 {
		return false
	}
	at, err := strconv.ParseInt(issued, 10, 64)
	return err == nil && time.Since(time.Unix(at, 0)) < gitAppStateTTL
}

// gitAppFailure returns the browser to the git settings page carrying what went
// wrong: these legs are redirects, so there is no request left to answer with a
// JSON error.
func gitAppFailure(w http.ResponseWriter, r *http.Request, reason string) {
	http.Redirect(w, r, gitSettingsPath+"?error="+url.QueryEscape(reason), http.StatusFound)
}
