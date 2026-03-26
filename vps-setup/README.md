# VPS Setup

Configuration files for the rusNAS distribution server at `activate.rusnas.ru`.

## Files

- `nginx-rusnas.conf` — nginx virtual host config

## Deploy nginx config

```bash
scp vps-setup/nginx-rusnas.conf rusnas-vps:/etc/nginx/sites-available/rusnas
ssh rusnas-vps "ln -sf /etc/nginx/sites-available/rusnas /etc/nginx/sites-enabled/rusnas \
  && nginx -t \
  && systemctl reload nginx"
```

## Initial VPS setup

1. Provision Debian 12/13 VPS, point `activate.rusnas.ru` DNS → VPS IP
2. Install: `apt install nginx certbot python3-certbot-nginx reprepro`
3. Get TLS cert: `certbot --nginx -d activate.rusnas.ru`
4. Deploy nginx config (above)
5. Deploy license server: see `rusnas-license-server/README.md`
6. Deploy bootstrap.sh: `scp bootstrap.sh rusnas-vps:/var/www/rusnas-install/`
7. Set up apt repo with reprepro
