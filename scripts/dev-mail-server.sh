#!/usr/bin/env bash
# A local IMAP + SMTP server for developing Tern, so nothing is tested against a real mailbox.
#
# Stalwart 0.15 runs as your user on 127.0.0.1 only: IMAPS on 1993, IMAP + STARTTLS on 1143, SMTPS
# submission on 1465, SMTP + STARTTLS submission on 1587.
# Its certificate comes from a local test CA that Tern trusts only when started through `tern`,
# which sets SSL_CERT_FILE; the system trust store is never touched.
#
#   scripts/dev-mail-server.sh setup      download, verify, create CA, config and test account
#   scripts/dev-mail-server.sh start      run the server in the foreground (Ctrl C stops it)
#   scripts/dev-mail-server.sh seed [n]   add an Archive folder and send n test messages (default 20)
#   scripts/dev-mail-server.sh account    print what to type into Tern's "Add an account" form
#   scripts/dev-mail-server.sh tern       start `npm run tauri dev` trusting the test CA
#   scripts/dev-mail-server.sh test       run the engine's checks against the running server
#   scripts/dev-mail-server.sh reset      delete all mail on the server, keep the setup
#
# Stalwart 0.16 keeps its settings in its database behind a separate CLI, so this stays on 0.15.
set -euo pipefail

VERSION=v0.15.5
SHA256=38ea325845c6de77e062d3295b107d01cb804205de1f8186a78f6ffdec1a2832
ASSET=stalwart-x86_64-unknown-linux-gnu.tar.gz
DIR=${TERN_DEVMAIL:-$HOME/.local/share/tern-devmail}
EMAIL=test@localhost
REPO=$(cd "$(dirname "$0")/.." && pwd)

die() { echo "dev-mail-server: $*" >&2; exit 1; }
password() { cat "$DIR/test-password"; }
curl_mail() { SSL_CERT_FILE="$DIR/tls/trust-bundle.pem" curl -sS --user "$EMAIL:$(password)" "$@"; }

setup() {
  [ "$(uname -sm)" = "Linux x86_64" ] || die "only Linux x86_64 is scripted"
  mkdir -p "$DIR/bin" "$DIR/data" "$DIR/tls"

  if [ ! -x "$DIR/bin/stalwart" ] || ! "$DIR/bin/stalwart" --version | grep -qx "${VERSION#v}"; then
    local tmp
    tmp=$(mktemp -d)
    echo "Downloading Stalwart $VERSION..."
    curl -fL --progress-bar -o "$tmp/$ASSET" \
      "https://github.com/stalwartlabs/stalwart/releases/download/$VERSION/$ASSET"
    echo "$SHA256  $tmp/$ASSET" | sha256sum -c --quiet - || die "checksum mismatch; not installing"
    tar xzf "$tmp/$ASSET" -C "$DIR/bin" stalwart
    chmod +x "$DIR/bin/stalwart"
    rm -rf "$tmp"
  fi

  if [ ! -f "$DIR/tls/server.pem" ]; then
    echo "Creating the test CA and a certificate for localhost..."
    (
      cd "$DIR/tls"
      openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 825 \
        -subj "/CN=Tern dev test CA" -addext "basicConstraints=critical,CA:TRUE" \
        -addext "keyUsage=critical,keyCertSign,cRLSign" -keyout ca.key -out ca.pem 2>/dev/null
      openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=localhost" \
        -keyout server.key -out server.csr 2>/dev/null
      openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 825 -out server.pem \
        -extfile <(printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE') \
        2>/dev/null
      chmod 600 ca.key server.key
    )
  fi
  # Rebuilt every time, so it follows updates to the system store.
  local system_bundle
  for system_bundle in /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem /etc/pki/tls/certs/ca-bundle.crt; do
    [ -f "$system_bundle" ] && break
  done
  cat "$system_bundle" "$DIR/tls/ca.pem" >"$DIR/tls/trust-bundle.pem"

  if [ ! -f "$DIR/test-password" ]; then
    (umask 077 && openssl rand -hex 12 >"$DIR/test-password")
  fi

  local pw
  pw=$(password)
  cat >"$DIR/config.toml" <<EOF
# Tern dev mail server, written by scripts/dev-mail-server.sh. Loopback only; test data only.
[server]
hostname = "localhost"

[server.listener.imaps]
bind = ["127.0.0.1:1993"]
protocol = "imap"
tls.implicit = true

# Plain IMAP that upgrades with STARTTLS, for testing that path.
[server.listener.imap]
bind = ["127.0.0.1:1143"]
protocol = "imap"

# Submission with STARTTLS, the other way clients send.
[server.listener.submission]
bind = ["127.0.0.1:1587"]
protocol = "smtp"

[server.listener.submissions]
bind = ["127.0.0.1:1465"]
protocol = "smtp"
tls.implicit = true

[server.listener.http]
bind = ["127.0.0.1:18080"]
protocol = "http"

[certificate.default]
cert = "%{file:$DIR/tls/server.pem}%"
private-key = "%{file:$DIR/tls/server.key}%"
default = true

[store.db]
type = "rocksdb"
path = "$DIR/data"
compression = "lz4"

[storage]
data = "db"
fts = "db"
blob = "db"
lookup = "db"
directory = "memory"

[directory.memory]
type = "memory"

[[directory.memory.principals]]
name = "$EMAIL"
class = "individual"
secret = "$pw"
email = ["$EMAIL"]

[authentication.fallback-admin]
user = "admin"
secret = "$pw"

# Test traffic only: no inbound rate limits. Stalwart's defaults (5 connections a second per address, 25 messages
# an hour per sender) are exceeded by a single run of the dev-server checks.
[queue.limiter.inbound.ip]
enable = false

[queue.limiter.inbound.sender]
enable = false

[tracer.stdout]
type = "stdout"
level = "info"
ansi = false
enable = true
EOF
  chmod 600 "$DIR/config.toml"
  echo "Ready. Start it with: $0 start"
}

start() {
  [ -f "$DIR/config.toml" ] || die "run setup first"
  exec "$DIR/bin/stalwart" --config "$DIR/config.toml"
}

seed() {
  local n=${1:-20} i
  curl_mail --url "imaps://localhost:1993/" -X 'LIST "" "Archive"' | grep -q Archive ||
    curl_mail --url "imaps://localhost:1993/" -X 'CREATE Archive (USE (\Archive))'
  for i in $(seq 1 "$n"); do
    printf 'From: Seed %s <seed%s@localhost>\r\nTo: %s\r\nSubject: Test message %s\r\nMessage-ID: <seed-%s-%s@localhost>\r\nDate: %s\r\n\r\nThis is test message %s.\r\n' \
      "$i" "$i" "$EMAIL" "$i" "$i" "$(date +%s%N)" "$(date -R)" "$i" |
      curl_mail --url smtps://localhost:1465 --mail-from "$EMAIL" --mail-rcpt "$EMAIL" --upload-file -
    sleep 0.25 # Stalwart allowed 5 connections a second per IP before its limits were turned off; kept for older setups
  done
  echo "Sent $n messages to $EMAIL."
}

account() {
  cat <<EOF
Email:            $EMAIL
Password:         $(password)
Server settings:  IMAP server localhost, port 1993; SMTP server localhost, port 1465
EOF
}

tern() {
  [ -f "$DIR/tls/trust-bundle.pem" ] || die "run setup first"
  cd "$REPO"
  SSL_CERT_FILE="$DIR/tls/trust-bundle.pem" exec npm run tauri dev
}

run_tests() {
  [ -f "$DIR/tls/trust-bundle.pem" ] || die "run setup first"
  cd "$REPO"
  # One at a time: the checks share one inbox.
  SSL_CERT_FILE="$DIR/tls/trust-bundle.pem" exec cargo test -p tern-core -- --ignored --test-threads=1
}

reset() {
  pgrep -x stalwart >/dev/null && die "stop the server first"
  rm -rf "${DIR:?}/data" && mkdir -p "$DIR/data"
  echo "Mail deleted. Start the server and run seed again."
}

case ${1:-} in
  setup | start | account | tern | reset) "$1" ;;
  seed) seed "${2:-20}" ;;
  test) run_tests ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
