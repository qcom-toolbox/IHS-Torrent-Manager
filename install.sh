#!/usr/bin/env bash
#
# IHS Torrent Manager - interactive Debian installer
#
#   sudo ./install.sh
#
# Installs (or upgrades/repairs/reconfigures/uninstalls) the management
# panel, background sync worker, download portal, and qBittorrent-nox as
# systemd services on a Debian server.

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants & globals
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$SCRIPT_DIR"

DEFAULT_APP_DIR="/opt/ihs-torrent-manager"
DEFAULT_DOWNLOAD_DIR="/srv/torrents"
DATA_DIR="/var/lib/ihs-torrent-manager"
CONFIG_DIR="/etc/ihs-torrent-manager"
SERVICE_USER="ihs-torrent-manager"
SYSTEMD_DIR="/etc/systemd/system"
STATE_FILE="$CONFIG_DIR/install.conf"

DEFAULT_APP_PORT=3000
DEFAULT_PORTAL_PORT=3001
DEFAULT_QBT_PORT=8080

MIN_RAM_MB=768
RECOMMENDED_RAM_MB=2048
MIN_DISK_MB=2048

NODE_MAJOR=20
SUPPORTED_DEBIAN_CODENAMES="bullseye bookworm trixie"

# Populated by prompts / detection
APP_DIR=""
DOWNLOAD_DIR=""
APP_PORT=""
PORTAL_PORT=""
QBT_PORT=""
ADMIN_USERNAME=""
ADMIN_PASSWORD=""
PORTAL_PASSWORD=""
ORG_NAME=""

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [[ -t 1 ]]; then
  C_RESET='\033[0m'; C_BOLD='\033[1m'; C_RED='\033[31m'; C_GREEN='\033[32m'
  C_YELLOW='\033[33m'; C_BLUE='\033[34m'
else
  C_RESET=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi

log()   { printf '%b\n' "${C_BLUE}==>${C_RESET} $*"; }
ok()    { printf '%b\n' "${C_GREEN}[OK]${C_RESET} $*"; }
warn()  { printf '%b\n' "${C_YELLOW}[WARN]${C_RESET} $*"; }
fail()  { printf '%b\n' "${C_RED}[FAIL]${C_RESET} $*"; }
die()   { fail "$*"; exit 1; }
header() {
  echo
  printf '%b\n' "${C_BOLD}========================================${C_RESET}"
  printf '%b\n' "${C_BOLD} $*${C_RESET}"
  printf '%b\n' "${C_BOLD}========================================${C_RESET}"
  echo
}

prompt() {
  # prompt <varname> <question> <default>
  local __var="$1" __question="$2" __default="${3:-}"
  local __answer
  if [[ -n "$__default" ]]; then
    read -r -p "$__question [$__default]: " __answer || true
    __answer="${__answer:-$__default}"
  else
    read -r -p "$__question: " __answer || true
  fi
  printf -v "$__var" '%s' "$__answer"
}

prompt_secret() {
  # prompt_secret <varname> <question>
  local __var="$1" __question="$2"
  local __answer __confirm
  while true; do
    read -r -s -p "$__question: " __answer || true
    echo
    read -r -s -p "Confirm: " __confirm || true
    echo
    if [[ -z "$__answer" ]]; then
      warn "Value cannot be empty."
      continue
    fi
    if [[ "$__answer" != "$__confirm" ]]; then
      warn "Values did not match, please try again."
      continue
    fi
    break
  done
  printf -v "$__var" '%s' "$__answer"
}

confirm() {
  # confirm <question> -> returns 0 for yes
  local __question="$1" __answer
  read -r -p "$__question [y/N]: " __answer || true
  [[ "$__answer" =~ ^[Yy]$ ]]
}

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    die "This installer must be run as root, e.g.: sudo ./install.sh"
  fi
}

# ---------------------------------------------------------------------------
# System detection
# ---------------------------------------------------------------------------

detect_system() {
  header "System Detection"

  if [[ ! -f /etc/os-release ]]; then
    die "Cannot detect operating system (/etc/os-release missing). This installer targets Debian."
  fi
  # shellcheck disable=SC1091
  source /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_CODENAME="${VERSION_CODENAME:-unknown}"
  OS_VERSION="${VERSION_ID:-unknown}"

  if [[ "$OS_ID" != "debian" ]]; then
    warn "This installer targets Debian. Detected: ${PRETTY_NAME:-$OS_ID}."
    if ! confirm "Continue anyway on an unsupported OS?"; then
      die "Aborted."
    fi
  else
    ok "Debian ${OS_VERSION} (${OS_CODENAME}) detected"
    if [[ ! " $SUPPORTED_DEBIAN_CODENAMES " == *" $OS_CODENAME "* ]]; then
      warn "Debian codename '$OS_CODENAME' is not in the actively-tested list ($SUPPORTED_DEBIAN_CODENAMES)."
      if ! confirm "Continue anyway?"; then
        die "Aborted."
      fi
    fi
  fi

  ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  ok "Architecture: $ARCH"
  case "$ARCH" in
    amd64|arm64) ;;
    *) warn "Architecture '$ARCH' is not officially validated; continuing." ;;
  esac

  local ram_kb ram_mb
  ram_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
  ram_mb=$((ram_kb / 1024))
  if (( ram_mb < MIN_RAM_MB )); then
    die "Insufficient RAM: ${ram_mb}MB detected, at least ${MIN_RAM_MB}MB required."
  elif (( ram_mb < RECOMMENDED_RAM_MB )); then
    warn "RAM: ${ram_mb}MB detected (${RECOMMENDED_RAM_MB}MB+ recommended for comfortable operation)"
  else
    ok "RAM: ${ram_mb}MB"
  fi

  local disk_avail_kb disk_avail_mb
  disk_avail_kb="$(df -kP / | tail -1 | awk '{print $4}')"
  disk_avail_mb=$((disk_avail_kb / 1024))
  if (( disk_avail_mb < MIN_DISK_MB )); then
    die "Insufficient disk space: ${disk_avail_mb}MB free on /, at least ${MIN_DISK_MB}MB required for the application itself (this does NOT include torrent storage, which should be on its own volume/partition)."
  else
    ok "Disk space on /: ${disk_avail_mb}MB free"
  fi
}

detect_existing_installation() {
  if [[ -f "$STATE_FILE" ]]; then
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

collect_configuration() {
  header "IHS Torrent Manager Installation"

  prompt APP_DIR "Application directory" "$DEFAULT_APP_DIR"
  prompt DOWNLOAD_DIR "Download directory" "$DEFAULT_DOWNLOAD_DIR"

  echo
  log "Database: SQLite (embedded, no separate service to secure or expose)."
  echo

  prompt APP_PORT "Application port" "$DEFAULT_APP_PORT"
  prompt PORTAL_PORT "Download portal port" "$DEFAULT_PORTAL_PORT"
  prompt QBT_PORT "qBittorrent WebUI port" "$DEFAULT_QBT_PORT"

  echo
  while true; do
    prompt ADMIN_USERNAME "Admin username" ""
    if [[ "$ADMIN_USERNAME" =~ ^[a-zA-Z0-9_.-]{3,32}$ ]]; then
      break
    fi
    warn "Username must be 3-32 characters: letters, numbers, _ . -"
  done
  prompt_secret ADMIN_PASSWORD "Admin password"
  echo
  prompt_secret PORTAL_PASSWORD "Download portal password"
  echo
  prompt ORG_NAME "Organization name for the login-page access notice" "the system owner"
}

# ---------------------------------------------------------------------------
# Package / runtime installation
# ---------------------------------------------------------------------------

install_packages() {
  header "Installing Dependencies"

  export DEBIAN_FRONTEND=noninteractive
  log "Updating package lists..."
  apt-get update -qq

  log "Installing base packages..."
  apt-get install -y -qq --no-install-recommends \
    curl ca-certificates gnupg build-essential python3 sqlite3 \
    qbittorrent-nox rsync jq >/dev/null
  ok "Base packages installed"

  if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed -E 's/^v([0-9]+).*/\1/')" -lt "$NODE_MAJOR" ]]; then
    log "Installing Node.js ${NODE_MAJOR}.x from NodeSource..."
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
  fi
  ok "Node.js $(node -v) installed"
  ok "npm $(npm -v) installed"

  if ! command -v qbittorrent-nox >/dev/null 2>&1; then
    die "qbittorrent-nox failed to install"
  fi
  ok "qbittorrent-nox $(qbittorrent-nox --version 2>&1 | head -1 || echo unknown) installed"
}

create_system_user() {
  header "System User & Directories"

  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin --create-home "$SERVICE_USER"
    ok "Created system user '$SERVICE_USER'"
  else
    ok "System user '$SERVICE_USER' already exists"
  fi

  mkdir -p "$APP_DIR" "$DATA_DIR" "$DATA_DIR/qbittorrent" "$DOWNLOAD_DIR" "$CONFIG_DIR"

  chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR" "$DOWNLOAD_DIR"
  chmod 750 "$DATA_DIR" "$DOWNLOAD_DIR"
  chown root:"$SERVICE_USER" "$CONFIG_DIR"
  chmod 750 "$CONFIG_DIR"
  ok "Directories created and permissions set"
}

deploy_application_code() {
  header "Deploying Application Code"

  if [[ "$REPO_DIR" != "$APP_DIR" ]]; then
    log "Copying application files to $APP_DIR..."
    mkdir -p "$APP_DIR"
    rsync -a --delete \
      --exclude '.git' \
      --exclude 'node_modules' \
      --exclude '**/dist' \
      --exclude '**/node_modules' \
      "$REPO_DIR"/ "$APP_DIR"/
    ok "Application files copied"
  else
    ok "Running in place inside $APP_DIR"
  fi

  chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
}

build_application() {
  header "Building Application"

  log "Installing npm dependencies (this can take a few minutes)..."
  ( cd "$APP_DIR" && sudo -u "$SERVICE_USER" npm install --no-audit --no-fund --loglevel=error )
  ok "Dependencies installed"

  log "Compiling TypeScript and building the frontend..."
  ( cd "$APP_DIR" && sudo -u "$SERVICE_USER" npm run build )
  ok "Build complete"
}

# ---------------------------------------------------------------------------
# Secrets & configuration files
# ---------------------------------------------------------------------------

gen_secret() {
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
}

write_env_files() {
  header "Writing Configuration"

  local db_path="$DATA_DIR/ihs-torrent-manager.sqlite"
  local session_secret portal_session_secret qbt_username qbt_password

  if [[ -f "$CONFIG_DIR/app.env" ]] && grep -q '^SESSION_SECRET=' "$CONFIG_DIR/app.env"; then
    session_secret="$(grep '^SESSION_SECRET=' "$CONFIG_DIR/app.env" | cut -d= -f2-)"
  else
    session_secret="$(gen_secret)"
  fi
  if [[ -f "$CONFIG_DIR/portal.env" ]] && grep -q '^PORTAL_SESSION_SECRET=' "$CONFIG_DIR/portal.env"; then
    portal_session_secret="$(grep '^PORTAL_SESSION_SECRET=' "$CONFIG_DIR/portal.env" | cut -d= -f2-)"
  else
    portal_session_secret="$(gen_secret)"
  fi
  if [[ -f "$CONFIG_DIR/app.env" ]] && grep -q '^TORRENT_USERNAME=' "$CONFIG_DIR/app.env"; then
    qbt_username="$(grep '^TORRENT_USERNAME=' "$CONFIG_DIR/app.env" | cut -d= -f2-)"
    qbt_password="$(grep '^TORRENT_PASSWORD=' "$CONFIG_DIR/app.env" | cut -d= -f2-)"
  else
    qbt_username="tmgr_$(openssl rand -hex 4)"
    qbt_password="$(openssl rand -base64 24 | tr -d '=+/')"
  fi
  QBT_USERNAME="$qbt_username"
  QBT_PASSWORD="$qbt_password"

  cat > "$CONFIG_DIR/app.env" <<EOF
NODE_ENV=production
DATABASE_PATH=$db_path
TORRENT_DOWNLOAD_DIR=$DOWNLOAD_DIR
DISK_WARNING_THRESHOLD_PERCENT_FREE=20
DISK_CRITICAL_THRESHOLD_PERCENT_FREE=10
DISK_BLOCK_THRESHOLD_PERCENT_FREE=5
APP_PORT=$APP_PORT
APP_HOST=127.0.0.1
SESSION_SECRET=$session_secret
COOKIE_SECURE=false
TRUST_PROXY=false
MAX_UPLOAD_SIZE_BYTES=10485760
TORRENT_HOST=http://127.0.0.1:$QBT_PORT
TORRENT_USERNAME=$qbt_username
TORRENT_PASSWORD=$qbt_password
FRONTEND_DIST_DIR=$APP_DIR/frontend/dist
NOTICE_FILE_PATH=$CONFIG_DIR/notice.txt
DOWNLOAD_TOKEN_TTL_MINUTES=60
EOF

  cat > "$CONFIG_DIR/worker.env" <<EOF
NODE_ENV=production
DATABASE_PATH=$db_path
TORRENT_DOWNLOAD_DIR=$DOWNLOAD_DIR
DISK_WARNING_THRESHOLD_PERCENT_FREE=20
DISK_CRITICAL_THRESHOLD_PERCENT_FREE=10
DISK_BLOCK_THRESHOLD_PERCENT_FREE=5
TORRENT_HOST=http://127.0.0.1:$QBT_PORT
TORRENT_USERNAME=$qbt_username
TORRENT_PASSWORD=$qbt_password
WORKER_SYNC_INTERVAL_MS=5000
EOF

  # Deliberately no TORRENT_HOST/USERNAME/PASSWORD here -- the download
  # portal never receives qBittorrent credentials.
  cat > "$CONFIG_DIR/portal.env" <<EOF
NODE_ENV=production
DATABASE_PATH=$db_path
TORRENT_DOWNLOAD_DIR=$DOWNLOAD_DIR
PORTAL_PORT=$PORTAL_PORT
PORTAL_HOST=127.0.0.1
PORTAL_SESSION_SECRET=$portal_session_secret
COOKIE_SECURE=false
TRUST_PROXY=false
NOTICE_FILE_PATH=$CONFIG_DIR/notice.txt
DOWNLOAD_TOKEN_TTL_MINUTES=60
EOF

  chown root:"$SERVICE_USER" "$CONFIG_DIR"/*.env
  chmod 640 "$CONFIG_DIR"/*.env
  ok "Environment files written to $CONFIG_DIR (mode 640, readable only by root and $SERVICE_USER)"

  write_notice_file
}

write_notice_file() {
  # Preserve an admin's existing custom notice across upgrades/repairs --
  # only create it from the template on a genuinely fresh install.
  if [[ ! -f "$CONFIG_DIR/notice.txt" ]]; then
    local org="${ORG_NAME:-the system owner}"
    sed "s/__ORG_NAME__/${org//\//\\/}/g" "$APP_DIR/config/notice.txt" > "$CONFIG_DIR/notice.txt"
    chown root:"$SERVICE_USER" "$CONFIG_DIR/notice.txt"
    chmod 644 "$CONFIG_DIR/notice.txt"
    ok "Login-page access notice written to $CONFIG_DIR/notice.txt (edit this file anytime to change the wording)"
  fi
}

initialize_database() {
  header "Database & Admin Account"

  local db_path="$DATA_DIR/ihs-torrent-manager.sqlite"
  log "Running database migrations..."
  ( cd "$APP_DIR" && sudo -u "$SERVICE_USER" env DATABASE_PATH="$db_path" node shared/dist/db/migrate.js )
  ok "Migrations applied"

  if [[ -n "$ADMIN_USERNAME" ]]; then
    log "Creating administrator account..."
    ( cd "$APP_DIR" && sudo -u "$SERVICE_USER" env DATABASE_PATH="$db_path" node scripts/create-admin.js "$ADMIN_USERNAME" "$ADMIN_PASSWORD" )
    ok "Administrator '$ADMIN_USERNAME' ready"
  fi

  if [[ -n "$PORTAL_PASSWORD" ]]; then
    log "Setting download portal password..."
    ( cd "$APP_DIR" && sudo -u "$SERVICE_USER" env DATABASE_PATH="$db_path" node scripts/set-portal-password.js "$PORTAL_PASSWORD" )
    ok "Download portal password set"
  fi
}

# ---------------------------------------------------------------------------
# qBittorrent bootstrap
# ---------------------------------------------------------------------------

# Checks that qBittorrent's WebUI is up and speaking HTTP -- NOT that it's
# unauthenticated. qbt-bootstrap.js deliberately sets bypass_local_auth to
# false (even 127.0.0.1 must authenticate), so a healthy, fully-configured
# WebUI legitimately answers with 403 to this unauthenticated probe. `curl
# -f` treats any non-2xx as failure, which would misreport a perfectly
# healthy WebUI as down -- so this checks for "we got some HTTP response
# at all" (any 3-digit status code) rather than "we got a 2xx".
qbt_webui_reachable() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${QBT_PORT}/api/v2/app/version" 2>/dev/null)"
  [[ "$code" =~ ^[0-9]{3}$ && "$code" != "000" ]]
}

wait_for_qbittorrent_webui() {
  local tries=0
  until qbt_webui_reachable; do
    tries=$((tries + 1))
    if (( tries > 30 )); then
      return 1
    fi
    sleep 1
  done
  return 0
}

bootstrap_qbittorrent() {
  header "Configuring qBittorrent"

  local conf_dir="$DATA_DIR/qbittorrent/qBittorrent/config"
  mkdir -p "$conf_dir"
  if [[ ! -f "$conf_dir/qBittorrent.conf" ]]; then
    cat > "$conf_dir/qBittorrent.conf" <<EOF
[Preferences]
WebUI\\Address=127.0.0.1
WebUI\\Port=$QBT_PORT
WebUI\\LocalHostAuth=false
General\\Locale=en

[BitTorrent]
Session\\DefaultSavePath=$DOWNLOAD_DIR/
Session\\TempPath=$DOWNLOAD_DIR/.incomplete/
EOF
    mkdir -p "$DOWNLOAD_DIR/.incomplete"
  fi
  chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR/qbittorrent" "$DOWNLOAD_DIR"

  systemctl daemon-reload
  systemctl enable --now qbittorrent-nox >/dev/null

  log "Waiting for qBittorrent WebUI to become available..."
  if ! wait_for_qbittorrent_webui; then
    fail "qBittorrent WebUI did not become available on port $QBT_PORT."
    echo "  Diagnostics: systemctl status qbittorrent-nox ; journalctl -u qbittorrent-nox -n 50"
    die "qBittorrent bootstrap failed"
  fi
  ok "qBittorrent WebUI is responding"

  # Recent qBittorrent (4.6+) logs a randomly generated temporary WebUI
  # password on first start; older packaged versions default to
  # admin/adminadmin. Try both, in that order.
  local candidates_file
  candidates_file="$(mktemp)"
  local temp_pw
  temp_pw="$(journalctl -u qbittorrent-nox --no-pager -n 200 2>/dev/null | grep -oE 'temporary password[^:]*:\s*\S+' | grep -oE '\S+$' | tail -1 || true)"
  {
    # Already-bootstrapped installs (repair/reconfigure) will succeed on
    # the first try here; a genuinely fresh qBittorrent profile falls
    # through to the temp-password / default-password candidates.
    echo "${QBT_USERNAME}:${QBT_PASSWORD}"
    [[ -n "$temp_pw" ]] && echo "admin:$temp_pw"
    echo "admin:adminadmin"
  } > "$candidates_file"

  if node "$APP_DIR/scripts/qbt-bootstrap.js" 127.0.0.1 "$QBT_PORT" "$QBT_USERNAME" "$QBT_PASSWORD" "$candidates_file"; then
    ok "qBittorrent WebUI credentials configured (bound to 127.0.0.1:$QBT_PORT, never exposed publicly)"
  else
    rm -f "$candidates_file"
    fail "Could not automatically configure qBittorrent WebUI credentials."
    echo "  This can happen if qBittorrent's first-start banner format changed, or the WebUI was already configured."
    echo "  Diagnostics: journalctl -u qbittorrent-nox -n 100"
    echo "  You can configure it manually by SSH tunneling to 127.0.0.1:$QBT_PORT and setting the WebUI username/password"
    echo "  to match TORRENT_USERNAME/TORRENT_PASSWORD in $CONFIG_DIR/app.env, or re-run: sudo ./install.sh (choose Repair)."
    die "qBittorrent bootstrap failed"
  fi
  rm -f "$candidates_file"

  systemctl restart qbittorrent-nox
  log "Waiting for qBittorrent WebUI to come back up after the final restart..."
  if ! wait_for_qbittorrent_webui; then
    warn "qBittorrent WebUI did not respond within 30s after the final restart -- it may just be slow to start on this hardware."
    warn "Diagnostics: systemctl status qbittorrent-nox ; journalctl -u qbittorrent-nox -n 50"
  fi
}

# ---------------------------------------------------------------------------
# systemd
# ---------------------------------------------------------------------------

# Writes/refreshes the unit files and reloads systemd's view of them, but
# does not enable or start anything. Split out from install_systemd_units()
# so it can run BEFORE bootstrap_qbittorrent() -- on a genuinely fresh
# ("barebone") server, /etc/systemd/system/qbittorrent-nox.service does not
# exist yet, and `systemctl enable --now qbittorrent-nox` inside
# bootstrap_qbittorrent() would otherwise fail with "Unit ... does not
# exist" because the unit file hadn't been installed yet.
write_systemd_unit_files() {
  header "Installing systemd Unit Files"

  local src dest
  for name in ihs-torrent-manager ihs-torrent-manager-worker ihs-torrent-manager-portal qbittorrent-nox; do
    src="$APP_DIR/systemd/${name}.service"
    dest="$SYSTEMD_DIR/${name}.service"
    sed \
      -e "s#__APP_DIR__#${APP_DIR}#g" \
      -e "s#__DATA_DIR__#${DATA_DIR}#g" \
      -e "s#__DOWNLOAD_DIR__#${DOWNLOAD_DIR}#g" \
      -e "s#__CONFIG_DIR__#${CONFIG_DIR}#g" \
      -e "s#__SERVICE_USER__#${SERVICE_USER}#g" \
      "$src" > "$dest"
  done
  systemctl daemon-reload
  ok "Unit files written to $SYSTEMD_DIR"
}

install_systemd_units() {
  header "Configuring systemd Services"

  systemctl enable qbittorrent-nox ihs-torrent-manager ihs-torrent-manager-worker ihs-torrent-manager-portal >/dev/null
  ok "Services enabled at boot"

  systemctl restart ihs-torrent-manager-worker
  systemctl restart ihs-torrent-manager
  systemctl restart ihs-torrent-manager-portal
  ok "Services started"
}

# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------

configure_firewall() {
  header "Firewall"

  if ! command -v ufw >/dev/null 2>&1; then
    warn "UFW is not installed. Skipping firewall configuration -- configure your firewall manually to allow ports $APP_PORT and $PORTAL_PORT (TCP), and keep qBittorrent's WebUI port ($QBT_PORT) restricted to localhost."
    return
  fi

  local ufw_status
  ufw_status="$(ufw status | head -1)"
  log "Detected UFW ($ufw_status)"

  if confirm "Allow inbound TCP $APP_PORT (management panel) and $PORTAL_PORT (download portal) through UFW?"; then
    ufw allow "$APP_PORT"/tcp comment 'IHS Torrent Manager panel' >/dev/null
    ufw allow "$PORTAL_PORT"/tcp comment 'IHS Torrent Manager download portal' >/dev/null
    ok "UFW rules added for ports $APP_PORT and $PORTAL_PORT"
    warn "qBittorrent's WebUI port ($QBT_PORT) is bound to 127.0.0.1 and intentionally NOT opened in the firewall."
  else
    warn "Skipped firewall changes. Existing UFW rules were not modified."
  fi
}

# ---------------------------------------------------------------------------
# Optional reverse proxy
# ---------------------------------------------------------------------------

configure_reverse_proxy() {
  header "Reverse Proxy (optional)"

  echo "  1) None -- access the panel/portal directly on their ports"
  echo "  2) nginx"
  echo "  3) Caddy"
  local choice
  prompt choice "Choose an option" "1"

  case "$choice" in
    2)
      if ! command -v nginx >/dev/null 2>&1; then
        apt-get install -y -qq nginx >/dev/null
      fi
      local domain
      prompt domain "Domain name to serve the panel on (leave blank to skip)" ""
      if [[ -n "$domain" ]]; then
        cat > "/etc/nginx/sites-available/ihs-torrent-manager" <<EOF
server {
    listen 80;
    server_name $domain;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}

server {
    listen 80;
    server_name downloads.$domain;

    location / {
        proxy_pass http://127.0.0.1:$PORTAL_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
        ln -sf /etc/nginx/sites-available/ihs-torrent-manager /etc/nginx/sites-enabled/ihs-torrent-manager
        nginx -t && systemctl reload nginx
        sed -i 's/^TRUST_PROXY=.*/TRUST_PROXY=true/' "$CONFIG_DIR/app.env" "$CONFIG_DIR/portal.env"
        ok "nginx configured for $domain (panel) and downloads.$domain (portal)."
        log "Run 'certbot --nginx' separately to enable HTTPS for these domains."
      else
        warn "No domain provided; skipped nginx site configuration."
      fi
      ;;
    3)
      if ! command -v caddy >/dev/null 2>&1; then
        apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list 2>/dev/null || true
        if ! (apt-get update -qq && apt-get install -y -qq caddy >/dev/null); then
          warn "Automatic Caddy installation failed; install it manually from https://caddyserver.com/docs/install"
        fi
      fi
      local domain
      prompt domain "Domain name to serve the panel on (leave blank to skip)" ""
      if [[ -n "$domain" ]] && command -v caddy >/dev/null 2>&1; then
        cat >> /etc/caddy/Caddyfile <<EOF

$domain {
    reverse_proxy 127.0.0.1:$APP_PORT
}

downloads.$domain {
    reverse_proxy 127.0.0.1:$PORTAL_PORT
}
EOF
        systemctl reload caddy
        sed -i 's/^TRUST_PROXY=.*/TRUST_PROXY=true/' "$CONFIG_DIR/app.env" "$CONFIG_DIR/portal.env"
        ok "Caddy configured for $domain (panel) and downloads.$domain (portal). Caddy provisions HTTPS automatically."
      else
        warn "Skipped Caddy site configuration."
      fi
      ;;
    *)
      log "No reverse proxy configured."
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Health checks
# ---------------------------------------------------------------------------

# Node needs a moment after `systemctl restart` to load config, open the
# database, and bind its port -- a single immediate curl right after
# install_systemd_units() restarts everything is a real race, especially
# on the repair/reconfigure paths which (unlike a fresh install) have no
# interactive prompts in between to incidentally cover that startup time.
wait_for_http_ok() {
  local url="$1" tries=0
  until curl -fs "$url" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if (( tries > 10 )); then
      return 1
    fi
    sleep 1
  done
  return 0
}

run_health_checks() {
  header "Health Checks"

  local all_ok=1

  if systemctl is-active --quiet qbittorrent-nox; then ok "qBittorrent service is running"; else fail "qBittorrent service is not running"; all_ok=0; fi
  if qbt_webui_reachable; then ok "qBittorrent"; else fail "qBittorrent WebUI not responding"; all_ok=0; fi

  if [[ -f "$DATA_DIR/ihs-torrent-manager.sqlite" ]]; then ok "Database"; else fail "Database file not found"; all_ok=0; fi

  if systemctl is-active --quiet ihs-torrent-manager-worker; then ok "Torrent Worker"; else fail "Torrent Worker service is not running"; all_ok=0; fi

  if systemctl is-active --quiet ihs-torrent-manager; then
    if wait_for_http_ok "http://127.0.0.1:${APP_PORT}/api/health"; then
      ok "Management Panel"
    else
      fail "Management Panel service is running but not responding on port $APP_PORT"
      all_ok=0
    fi
  else
    fail "Management Panel service is not running"
    all_ok=0
  fi

  if systemctl is-active --quiet ihs-torrent-manager-portal; then
    if wait_for_http_ok "http://127.0.0.1:${PORTAL_PORT}/health"; then
      ok "Download Portal"
    else
      fail "Download Portal service is running but not responding on port $PORTAL_PORT"
      all_ok=0
    fi
  else
    fail "Download Portal service is not running"
    all_ok=0
  fi

  if [[ -d "$DOWNLOAD_DIR" && -w "$DOWNLOAD_DIR" ]]; then ok "Storage ($DOWNLOAD_DIR writable by $SERVICE_USER)"; else fail "Storage directory missing or not writable"; all_ok=0; fi

  if [[ -n "${ADMIN_USERNAME:-}" ]]; then
    local login_response
    login_response="$(curl -fs -X POST "http://127.0.0.1:${APP_PORT}/api/auth/login" \
      -H 'Content-Type: application/json' \
      -d "{\"username\":\"${ADMIN_USERNAME}\",\"password\":$(node -e "console.log(JSON.stringify(process.argv[1]))" "$ADMIN_PASSWORD")}" \
      2>/dev/null || true)"
    if echo "$login_response" | grep -q '"user"'; then
      ok "Authentication (admin login verified)"
    else
      fail "Authentication check failed -- could not log in as '$ADMIN_USERNAME'"
      all_ok=0
    fi
  fi

  echo
  if (( all_ok )); then
    ok "All health checks passed."
  else
    fail "One or more health checks failed. Diagnostics:"
    echo "    systemctl status ihs-torrent-manager ihs-torrent-manager-worker ihs-torrent-manager-portal qbittorrent-nox"
    echo "    journalctl -u ihs-torrent-manager -n 100"
    echo "    journalctl -u ihs-torrent-manager-worker -n 100"
    echo "    journalctl -u ihs-torrent-manager-portal -n 100"
    echo "    journalctl -u qbittorrent-nox -n 100"
  fi
}

print_summary() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  ip="${ip:-<server-ip>}"

  header "Installation Complete"
  cat <<EOF
Management panel:   http://${ip}:${APP_PORT}   (or http://127.0.0.1:${APP_PORT} on this host)
Download portal:     http://${ip}:${PORTAL_PORT}   (or http://127.0.0.1:${PORTAL_PORT} on this host)

Application directory:   $APP_DIR
Torrent storage:         $DOWNLOAD_DIR
Database:                $DATA_DIR/ihs-torrent-manager.sqlite
Configuration:            $CONFIG_DIR/{app,worker,portal}.env

Services:
  systemctl status ihs-torrent-manager
  systemctl status ihs-torrent-manager-worker
  systemctl status ihs-torrent-manager-portal
  systemctl status qbittorrent-nox

Logs:
  journalctl -u ihs-torrent-manager -f
  journalctl -u ihs-torrent-manager-worker -f
  journalctl -u ihs-torrent-manager-portal -f

To upgrade later:   sudo ./install.sh   (choose "Upgrade" when an existing installation is detected)
To uninstall:       sudo ./uninstall.sh
EOF
}

# ---------------------------------------------------------------------------
# State file (used to detect + drive upgrade/repair/reconfigure)
# ---------------------------------------------------------------------------

save_state() {
  cat > "$STATE_FILE" <<EOF
APP_DIR=$APP_DIR
DOWNLOAD_DIR=$DOWNLOAD_DIR
APP_PORT=$APP_PORT
PORTAL_PORT=$PORTAL_PORT
QBT_PORT=$QBT_PORT
INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
VERSION=1
EOF
  chmod 640 "$STATE_FILE"
  chown root:"$SERVICE_USER" "$STATE_FILE"
}

load_state() {
  # shellcheck disable=SC1090
  source "$STATE_FILE"
}

# ---------------------------------------------------------------------------
# Top-level flows
# ---------------------------------------------------------------------------

run_fresh_install() {
  collect_configuration
  install_packages
  create_system_user
  deploy_application_code
  build_application
  write_env_files
  initialize_database
  write_systemd_unit_files
  bootstrap_qbittorrent
  install_systemd_units
  configure_firewall
  configure_reverse_proxy
  save_state
  run_health_checks
  print_summary
}

run_upgrade() {
  header "Upgrading Existing Installation"
  load_state
  ok "Existing installation found: $APP_DIR (installed $INSTALLED_AT)"
  log "Database, torrent data, users, and secrets will be preserved."

  install_packages
  create_system_user
  deploy_application_code
  build_application
  write_env_files
  initialize_database_upgrade_only
  write_systemd_unit_files
  install_systemd_units
  save_state
  run_health_checks
  header "Upgrade Complete"
}

initialize_database_upgrade_only() {
  header "Database"
  local db_path="$DATA_DIR/ihs-torrent-manager.sqlite"
  log "Running database migrations (existing data is preserved)..."
  ( cd "$APP_DIR" && sudo -u "$SERVICE_USER" env DATABASE_PATH="$db_path" node shared/dist/db/migrate.js )
  ok "Migrations applied"
}

run_repair() {
  header "Repairing Installation"
  load_state
  ADMIN_USERNAME=""   # do not touch existing accounts
  ADMIN_PASSWORD=""
  PORTAL_PASSWORD=""

  create_system_user
  deploy_application_code
  build_application
  write_env_files
  initialize_database_upgrade_only
  write_systemd_unit_files
  bootstrap_qbittorrent
  install_systemd_units
  run_health_checks
  header "Repair Complete"
}

run_reconfigure() {
  header "Reconfiguring Installation"
  load_state
  log "Current settings: app dir=$APP_DIR, download dir=$DOWNLOAD_DIR, panel port=$APP_PORT, portal port=$PORTAL_PORT, qBittorrent port=$QBT_PORT"
  echo
  prompt APP_PORT "Application port" "$APP_PORT"
  prompt PORTAL_PORT "Download portal port" "$PORTAL_PORT"
  prompt QBT_PORT "qBittorrent WebUI port" "$QBT_PORT"
  echo
  if confirm "Reset the administrator account?"; then
    while true; do
      prompt ADMIN_USERNAME "Admin username" ""
      [[ "$ADMIN_USERNAME" =~ ^[a-zA-Z0-9_.-]{3,32}$ ]] && break
      warn "Username must be 3-32 characters: letters, numbers, _ . -"
    done
    prompt_secret ADMIN_PASSWORD "Admin password"
  fi
  if confirm "Reset the download portal password?"; then
    prompt_secret PORTAL_PASSWORD "Download portal password"
  fi

  mkdir -p "$DOWNLOAD_DIR"
  chown "$SERVICE_USER:$SERVICE_USER" "$DOWNLOAD_DIR"

  write_env_files
  [[ -n "$ADMIN_USERNAME" || -n "$PORTAL_PASSWORD" ]] && initialize_database
  write_systemd_unit_files
  bootstrap_qbittorrent
  install_systemd_units
  configure_firewall
  save_state
  run_health_checks
  header "Reconfiguration Complete"
}

existing_install_menu() {
  load_state
  header "Existing Installation Detected"
  cat <<EOF
An installation already exists at: $APP_DIR
Installed: ${INSTALLED_AT:-unknown}

  1) Upgrade      - deploy the latest code, run migrations, keep all data
  2) Repair       - reinstall dependencies/services without touching accounts
  3) Reconfigure  - change ports/passwords
  4) Uninstall    - remove the application (with granular data options)
  5) Abort
EOF
  local choice
  prompt choice "Choose an option" "5"
  case "$choice" in
    1) run_upgrade ;;
    2) run_repair ;;
    3) run_reconfigure ;;
    4) exec "$SCRIPT_DIR/uninstall.sh" ;;
    *) log "Aborted, no changes made."; exit 0 ;;
  esac
}

main() {
  require_root
  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Usage: sudo ./install.sh"
    echo "Interactive installer for IHS Torrent Manager. Run with no arguments."
    exit 0
  fi

  detect_system

  if detect_existing_installation; then
    existing_install_menu
  else
    run_fresh_install
  fi
}

# Allow upgrade.sh to reuse these functions without triggering the
# interactive installer: `TM_SOURCED=1 source install.sh` skips main().
if [[ "${TM_SOURCED:-0}" != "1" ]]; then
  main "$@"
fi
