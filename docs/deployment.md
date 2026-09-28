# Deployment

`cosimo init` handles three targets itself: **local**, **docker** (any Linux server, with automatic
HTTPS from Caddy), and **fly** (Fly.io). The other platforms below are recipes you set up by hand.
They use the same container image and environment variables.

## What every deployment needs

| Need | How |
|---|---|
| Master key | `COSIMO_MASTER_KEY` (32 random bytes, base64: `openssl rand -base64 32`). Back it up; without it, stored bank connections and secrets can't be recovered. |
| Persistent data | A volume at `/data` (SQLite databases, attachments, backups). Alternatively, use Turso for databases and any S3-compatible bucket for attachments and backups ([docs/object-storage.md](object-storage.md)). |
| Public URL | `COSIMO_SERVER_PUBLIC_URL=https://books.example.com`, used for links in email, claim links, OAuth, and Plaid webhooks. |
| Proxy headers | `COSIMO_SERVER_TRUST_PROXY=true` when behind a reverse proxy or platform router. |
| One instance | The scheduler (bank sync, backups, reminders) runs in-process. Run exactly one replica and don't scale to zero. |

Any config key can be set as `COSIMO_<SECTION>_<KEY>` (see `cosimo config list`). The image is
`ghcr.io/steve-lomnes/cosimo:<version>`. It listens on port 8787 and runs as uid 10001.

After the first start, create the admin and first organization inside the container:

```sh
echo '{"admin_email":"you@example.com","org_name":"My Business LLC","target":"docker"}' \
  | cosimo init --in-container --answers - --yes --json
```

This prints a claim link. Open it to set your password.

## Docker (built in)

```sh
cosimo init    # target: docker, domain: books.example.com
```

This writes `cosimo/docker-compose.yml`, `cosimo/Caddyfile`, `cosimo/config/config.toml`, and
`cosimo/.env` (mode 0600, holds the master key) in the current directory. It then creates the admin
inside the container and starts Cosimo plus Caddy. The DNS A/AAAA record must point at the server,
and ports 80 and 443 must be open. Use `--no-deploy` to only write the files.

Useful commands (run in the `cosimo/` directory):

```sh
docker compose logs -f cosimo
docker compose exec cosimo cosimo doctor
docker compose exec cosimo cosimo user claim-link you@example.com
docker compose pull && docker compose up -d      # upgrade
```

## Fly.io (built in)

```sh
fly auth login
cosimo init    # target: fly
```

This writes `cosimo/fly.toml`, creates the app and a 1 GB volume, sets `COSIMO_MASTER_KEY` with
`fly secrets import`, deploys the image, and creates the admin over `fly ssh console`. Machines are
kept running (`auto_stop_machines = "off"`) because the scheduler runs in-process.

## Moving an existing instance to Turso

`cosimo move-storage` copies a SQLite-mode instance to Turso (or a self-hosted libSQL server with
namespaces) without losing anything. Every table of the system database and of every organization,
archived ones included, is copied as is. The same master key keeps working, so bank connections and
the Plaid and SMTP settings survive without re-entering them.

1. Stop the server. The command refuses to run while something answers on the configured port.
2. Run the move:

   ```sh
   TURSO_API_TOKEN=... cosimo move-storage --to turso --turso-org my-org --turso-group default \
     --env-out cosimo-turso.env
   ```

   For a libSQL server, use `--to libsql --libsql-admin-url http://db:8081 --libsql-base-url http://db:8080`
   (admin token, if any, in `LIBSQL_ADMIN_TOKEN`).

   It takes a safety backup, creates a `cosimo-system` database (`--system-name` to change it) and one
   `cosimo-<org id>` database per organization, and copies the data. It then points the copied
   organization registry at the new databases. Finally it checks every table's rows, each
   organization's hash chains and heads, and that the instance secrets still decrypt. If a step
   fails, it drops the databases it created and says so.
3. `--env-out` (mode 0600) holds what the new instance needs: `COSIMO_DATABASE_MODE`,
   `COSIMO_DATABASE_SYSTEM_URL`, `COSIMO_DATABASE_SYSTEM_AUTH_TOKEN`, the `COSIMO_DATABASE_TURSO_*`
   settings, and `COSIMO_MASTER_KEY`. On Fly: `fly secrets import < cosimo-turso.env`. Nothing
   secret is printed.
4. Attachments are not moved. The command prints where they are and how many there are. Copy that
   directory to the new host's `storage.dir` (on Fly, `/data/attachments`, for example with
   `fly ssh sftp shell`), or move them into an S3-compatible bucket instead with
   `cosimo move-attachments` ([docs/object-storage.md](object-storage.md)).

The local config and databases are left alone, so the old instance still works if you abandon the
move. Once the new one is running, keep the old one stopped: two schedulers would both sync banks.

## Railway

1. New project → **Deploy a Docker image** → `ghcr.io/steve-lomnes/cosimo:<version>`.
2. Add a **volume** mounted at `/data`.
3. Variables: `COSIMO_MASTER_KEY`, `COSIMO_SERVER_PUBLIC_URL=https://<your-domain>`,
   `COSIMO_SERVER_TRUST_PROXY=true`. Set the service port to **8787** (Cosimo does not read `PORT`).
4. Keep replicas at 1. After it starts, open the service shell and run the `init --in-container`
   command above.

## Render

1. New **Web Service** → **Existing image** → `ghcr.io/steve-lomnes/cosimo:<version>`.
2. Add a **persistent disk** mounted at `/data`. Disks need a paid instance type; free instances
   sleep, which stops the scheduler.
3. Environment: `COSIMO_MASTER_KEY`, `COSIMO_SERVER_PUBLIC_URL`, `COSIMO_SERVER_TRUST_PROXY=true`.
   Set the port to 8787 and the health check path to `/healthz`.
4. Open the **Shell** tab and run the `init --in-container` command above.

## Coolify

1. New resource → **Docker Image** → `ghcr.io/steve-lomnes/cosimo:<version>`, port 8787.
2. Add a persistent storage volume at `/data` and set the domain; Coolify's proxy handles HTTPS.
3. Environment: `COSIMO_MASTER_KEY`, `COSIMO_SERVER_PUBLIC_URL`, `COSIMO_SERVER_TRUST_PROXY=true`.
4. Run the `init --in-container` command in the container terminal.

## Bare Linux server with systemd (no Docker)

```sh
curl -fsSL https://github.com/steve-lomnes/cosimo/releases/latest/download/install.sh | sh -s -- --system --no-init     # installs /usr/local/bin/cosimo
sudo useradd --system --home /var/lib/cosimo --create-home cosimo
sudo -u cosimo cosimo init --answers answers.json --yes --json       # target: local, service: false,
                                                                     # public_url: https://books.example.com
```

`/etc/systemd/system/cosimo.service`:

```ini
[Unit]
Description=Cosimo bookkeeping server
After=network-online.target

[Service]
User=cosimo
ExecStart=/usr/local/bin/cosimo serve --config /var/lib/cosimo/.cosimo/config.toml
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl enable --now cosimo` and put a reverse proxy with HTTPS in front of
`127.0.0.1:8787`. For example, with Caddy: `books.example.com { reverse_proxy 127.0.0.1:8787 }`.
Set `server.trust_proxy = true`.

## Local

`cosimo init` with `target: local` runs on `http://localhost:8787`. With `service: true` it installs
a launchd agent (macOS), a systemd user unit (Linux; run `loginctl enable-linger $USER` to keep it
running while you're logged out), or a scheduled task at logon (Windows).

Plaid works through polling every 6 hours. Webhooks and some OAuth banks need a public HTTPS URL
(see [plaid.md](plaid.md)).
