# Heroku owner preview

This package is for one owner testing marketplace connections on a stable HTTPS domain. It is not a public multitenant seller platform. Every authorized preview user would share the same products, orders, and connected accounts. Do not give this owner login to unrelated sellers.

## Included deployment changes

- Node 24, a Procfile, a reproducible npm lockfile, 0.0.0.0 binding, and Heroku's PORT.
- HTTPS-only host validation, a dedicated /login page, same-origin/CSRF checks, and Secure OAuth cookies.
- Owner sessions use signed Secure/HttpOnly/SameSite cookies backed by hashed session tokens in PostgreSQL. Sessions expire after eight hours; Sign out revokes the token. Password rotation invalidates existing sessions.
- Login challenges are browser-bound, expire after ten minutes, and are consumed once in PostgreSQL. Login decisions use a database transaction/advisory lock across processes. A source is locked after five failures, and the owner account after ten failures from any sources, for fifteen minutes. Source backoff starts after three failures. Unknown usernames don't contribute to the owner-account counter; existing signed-in sessions remain usable during a lockout. Targeted account lockout still has an availability trade-off.
- Request counters are atomic and persistent: per source, 180 general requests/minute, 60 POST actions/minute, and 30 health requests/minute. Responses include Retry-After on throttling. Source keys use an HMAC of the rightmost originating address appended by the Heroku router; this assumes the documented Heroku Common Runtime routing path, not arbitrary untrusted reverse proxies.
- The Security view lists the latest 100 sign-in, session, sign-out, lockout and rate-limit events. Events have fixed reason codes and pseudonymous source hashes, with no passwords, cookies, raw IP addresses, marketplace tokens or submitted query strings. Records are retained for 30 days and expired counters/challenges are cleaned up lazily. Audit inserts are append-only through the app, except this documented retention cleanup; the shared database owner can still modify records.
- Marketplace callbacks use APP_ORIGIN and return to the hosted dashboard, not localhost.
- PostgreSQL-backed durable workspace snapshots, including orders, inventory, OAuth states, and encrypted tokens.
- Stable encryption and session secrets supplied through Config Vars, never ephemeral files.
- Responses are held until the database transaction commits, so a failed save cannot report a successful inventory update or connection.
- Live stock writes, listing publishing, and order imports remain disabled. Connection checks perform real read-only provider requests after authorization.

## Storage design and practical limit

The current synchronous SQLite domain engine runs against a temporary working file for each request. Its complete committed image is persisted as BYTEA in the commerce_hub_workspace PostgreSQL table. A PostgreSQL row lock serializes requests across dynos. The temporary file is disposable; the database snapshot and Config Vars are authoritative.

This deliberate preview adapter preserves the existing tested inventory rules without claiming a full PostgreSQL domain migration. The workspace is limited to 20 MB. It is suitable for a small owner test, not high-throughput commerce. Before opening to customers, migrate to normalized PostgreSQL domain tables, add per-user authentication/tenant isolation, durable workers, and marketplace reconciliation. A slow provider check also holds the preview workspace lock.

## Before deployment

Install the Heroku CLI if needed from https://devcenter.heroku.com/articles/heroku-cli and sign in to your own account. Do not paste Heroku credentials or marketplace secrets in chat.

Use your existing GitHub Student/Heroku offer, but inspect your Billing page and the selected dyno/database plan before provisioning. This package intentionally does not choose a dyno size or automatically purchase a database add-on.

An existing app's exact name and attached database are needed to deploy. If creating an app, choose its name and region first, then approve the concrete dyno/database selections. No resources have been created by preparing this package.

## Package only Commerce Hub

Run from commerce-hub:

    npm run package:heroku

The command prints a fresh dist/heroku-TIMESTAMP folder. It excludes .env, local data, encryption-key files, tests/screenshots, upstream reference sources, and the parent laundry app. Do not deploy the parent directory: its package.json starts the laundry application.

Deploy the generated folder as the root of a private source repository, or initialize a Git repository in that folder and push it to your Heroku Git remote after selecting the target app. For the latter:

    git init
    git add .
    git commit -m "Prepare Commerce Hub owner preview"
    heroku git:remote --app YOUR_EXISTING_APP_NAME
    git push heroku HEAD:main

Run those commands only inside the generated deployment folder. If Heroku asks for a buildpack, choose heroku/nodejs. The Procfile runs node server.mjs; the platform supplies PORT.

## Required Config Vars

In Heroku Dashboard → your app → Settings → Reveal Config Vars, set:

| Variable | Value |
|---|---|
| NODE_ENV | production |
| COMMERCE_DEPLOYMENT | owner-preview |
| APP_ORIGIN | Exact HTTPS origin from the app's Settings, without a path or trailing slash |
| DATABASE_URL | Supplied by your selected PostgreSQL add-on; do not invent or publish this value |
| OWNER_USER | Your chosen preview username |
| OWNER_PASSWORD | A unique password of at least 20 characters |
| SESSION_SECRET | A stable random secret of at least 32 characters |
| COMMERCE_TOKEN_KEY | Exactly 32 random bytes encoded in base64 |

Generate the encryption key locally:

    node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"

Generate a session secret or owner password locally:

    node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"

These commands print secrets in YOUR terminal for you to put in Config Vars; keep their output private. Retain COMMERCE_TOKEN_KEY across releases and dyno restarts. Changing it makes existing encrypted tokens unreadable. SESSION_SECRET should also be stable.

Leave OAUTH_CALLBACK_ORIGIN unset: the hosted app defaults it to APP_ORIGIN. If set, it must exactly equal APP_ORIGIN. LOCAL_APP_ORIGIN is for local mode and is ignored by the hosted deployment.

TLS certificate verification is enabled for PostgreSQL. If your database provider requires a custom CA, set PGSSL_CA to its PEM certificate. If its documented connection instructions require unverified TLS, set PGSSL_VERIFY=false explicitly after assessing that tradeoff. PGSSL=disable is accepted only for a loopback test database, never a remote hosted database. Connection-string sslmode parameters are removed so they cannot silently override these TLS choices.

## Marketplace settings

Configure the provider app credentials as described in CONNECTIONS.md, but use Heroku Config Vars instead of .env. They are still required; hosting cannot replace developer registration.

Register these exact URLs, using the app's actual HTTPS origin:

    APP_ORIGIN/oauth/shopify/return
    APP_ORIGIN/oauth/ebay/return
    APP_ORIGIN/oauth/amazon/return
    APP_ORIGIN/oauth/amazon/login

For eBay, put the generated RuName in EBAY_RUNAME. For Amazon's browser flow, use a public SP-API app and AMAZON_APPLICATION_ID; private self-authorized tokens are still available under owner setup. Use AMAZON_DRAFT=true for a draft app, and a matching AMAZON_REGION/AMAZON_MARKETPLACE. Start eBay testing with EBAY_ENVIRONMENT=sandbox and a Sandbox seller.

## Verify the deployed app

### Login lockout and recovery

Use a unique owner username; it is not a substitute for a strong password or throttling. During an account cooldown, all submitted usernames receive the same blocked response and Retry-After value. Unknown usernames do not increment the owner counter. Existing sessions remain usable. Distributed failures targeting the correct username can still prevent new sign-ins for fifteen minutes; changing the username reduces casual targeting but does not eliminate this trade-off.

Prefer waiting for the cooldown. For emergency recovery, an authorized database administrator can open `heroku pg:psql --app YOUR_APP_NAME`, inspect `SELECT bucket, failures, blocked_until FROM commerce_hub_auth_limits;`, and delete only the affected account/source buckets using their exact values. Do not routinely delete the entire table: that clears protection for every source. This manual recovery does not stop an ongoing attack. Rotating OWNER_USER or OWNER_PASSWORD also invalidates existing sessions; update the private login record when doing so.

If another proxy is added before Heroku, re-evaluate source-address trust before relying on source limits. Security activity is an access audit, not a marketplace-write audit or an administrator-tamperproof record.

### Reproduce the PostgreSQL security tests

The source review package includes `scripts/verify-security-postgres.mjs`. With dependencies installed, set SECURITY_TEST_DATABASE_URL to an explicitly chosen PostgreSQL test database and run `npm run test:postgres`. The database role needs permission to create a schema. The test creates a randomly named isolated schema, uses it for all test tables, and drops only that schema afterward. It does not use the public workspace tables. For local loopback PostgreSQL without TLS, also set PGSSL=disable; remote databases require TLS, with PGSSL_CA when needed. Do not share the connection string or terminal history containing it.

The checks cover persistent source/account limits, cooldown expiry, username-independent lockout responses, concurrent single-use challenges, request limits, audit data and retention. They do not verify provider behavior or live marketplace writes.

1. Open the app's HTTPS address. It redirects to /login; enter OWNER_USER/OWNER_PASSWORD in the form. No HTTP Basic browser dialog is used.
2. Open /api/health. It should return ok=true and storage=postgres-snapshot.
3. Add a disposable product, restart the dyno, and check that it remains.
4. Connect a test marketplace account and verify the displayed read-only API result.
5. Restart again, then run Check connection. Tokens should still decrypt and refresh correctly.
6. Use Disconnect from workspace, then revoke the grant on the marketplace if you no longer need it.

Local automated tests exercise the persistence transaction boundary with a fake PostgreSQL pool and mocked provider calls. They are not a substitute for the real Heroku database, TLS, and restart checks above. The hosted app is not represented as deployed until those checks succeed on the selected account.

Official deployment references:
- https://devcenter.heroku.com/articles/deploying-nodejs
- https://devcenter.heroku.com/articles/config-vars
- https://help.heroku.com/K1PPS2WM/why-are-my-file-uploads-missing-deleted-from-the-application

