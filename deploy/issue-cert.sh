#!/usr/bin/env bash
# Issue the Let's Encrypt IP-address certificate for Sonar (one time).
# Renewals afterwards are automatic (certbot service in docker-compose.prod.yml).
#
#   ./deploy/issue-cert.sh [IP]        default IP: 103.145.36.232
#   STAGING=1 ./deploy/issue-cert.sh   test against the staging CA first
set -euo pipefail
cd "$(dirname "$0")/.."

IP="${1:-103.145.36.232}"
COMPOSE="docker compose -f docker-compose.prod.yml"
STAGING_FLAG=""
[ "${STAGING:-0}" = "1" ] && STAGING_FLAG="--test-cert"

# 1) placeholder self-signed cert so nginx can start before the real one exists
mkdir -p deploy/ssl
if [ ! -s deploy/ssl/fullchain.pem ]; then
  openssl req -x509 -nodes -newkey rsa:2048 -days 7 \
    -keyout deploy/ssl/privkey.pem -out deploy/ssl/fullchain.pem \
    -subj "/CN=$IP" -addext "subjectAltName=IP:$IP" 2>/dev/null
  echo "placeholder certificate created"
fi
$COMPOSE up -d nginx

# 2) request the certificate (IP certs require the 6-day 'shortlived' profile).
#    The deploy hook copies the cert to deploy/ssl on issue AND on every renewal.
$COMPOSE run --rm --entrypoint certbot certbot certonly \
  --webroot -w /var/www/acme \
  --ip-address "$IP" --cert-name sonar \
  --preferred-profile shortlived \
  --agree-tos --register-unsafely-without-email --non-interactive \
  --keep-until-expiring $STAGING_FLAG \
  --deploy-hook 'cp -L "$RENEWED_LINEAGE/fullchain.pem" "$RENEWED_LINEAGE/privkey.pem" /etc/nginx/ssl/'

# 3) load the new certificate
$COMPOSE exec nginx nginx -s reload
echo "done — https://$IP"
