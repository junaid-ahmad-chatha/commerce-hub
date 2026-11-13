# Connect Amazon, eBay, and Shopify locally

This build supports real account authorization and read-only connection checks. Catalog/order imports and stock, price, fulfillment, and listing writes are not implemented. API verified means a real read request succeeded, not just that an authorization token was saved.

## Local setup

Copy .env.example to .env if .env does not already exist. Never overwrite existing credentials. Enter your developer application credentials in that local file, not in chat or frontend code. Configure one channel at a time if you prefer.

Run from commerce-hub:

    npm start

Open http://localhost:3100/#connections. Restart the Node server after editing .env. The alternative command is `node --env-file-if-exists=.env server.mjs`; `node server.mjs` alone does not load .env.

One account per channel is supported. Reconnecting replaces that channel's saved account but does not change product mappings. The other unconfigured channels remain available for later setup.

## HTTPS callbacks

For eBay and Amazon browser OAuth, use a registered HTTPS callback. Point your existing HTTPS tunnel (such as Cloudflare Tunnel or ngrok) to http://127.0.0.1:3100 and configure:

    LOCAL_APP_ORIGIN=http://localhost:3100
    OAUTH_CALLBACK_ORIGIN=https://YOUR-TUNNEL-HOST

Use localhost for the dashboard. The tunnel must preserve its public Host header or preserve forwarding headers. Do not configure it to strip forwarding information AND rewrite Host to localhost. Do not tunnel the parent laundry application.

Only OAuth return/login routes are accepted through the public host or forwarded requests. The dashboard, data APIs, setup guide, and connection controls are blocked there. The OAuth return redirects your browser to localhost, where a browser-bound cookie is verified before the code is exchanged. Keep the same browser profile throughout. Access/refresh tokens never appear in browser redirects.

Register exactly the URLs displayed under each channel's Platform owner setup:

    https://YOUR-TUNNEL-HOST/oauth/shopify/return
    https://YOUR-TUNNEL-HOST/oauth/ebay/return
    https://YOUR-TUNNEL-HOST/oauth/amazon/return

If your tunnel changes, update .env and the provider registrations, restart, and begin authorization again. Flows must start from Connections, not a marketplace app-store installation page, because this local prototype has no public user login.

## Shopify

1. Create/configure your app in Shopify's Dev Dashboard. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.
2. Configure a standalone app outside Shopify admin. For OAuth, enable authorization-code installation. CLI-managed configuration uses embedded=false and use_legacy_install_flow=true in the access_scopes section. Do not mix embedded session-token installation with this callback.
3. Register the displayed /oauth/shopify/return URL. For local-only development, the displayed http://localhost:3100/oauth/shopify/return can be used if accepted by your setup; otherwise use the HTTPS tunnel. Exact matching is required.
4. Configure read_products and read_inventory scopes matching SHOPIFY_SCOPES. The connection check itself only queries shop information, not orders or customer data.
5. Install/distribute the app to your test store using the supported development/custom distribution flow.
6. Choose Connect Shopify, enter the exact name.myshopify.com domain, and click Continue with Shopify. Sign in and approve on Shopify's official page. The browser returns to Connections and the app checks access. Sellers enter no API credentials in this flow.

Alternative for your own organization: after installing the app on a store owned by the SAME organization as the app, expand Shopify's Platform owner setup and open Developer connection options, then select Own organization: client credentials. The server requests a short-lived token without a merchant redirect. This cannot connect unrelated merchants' stores. Expired tokens are reacquired automatically with the app credentials.

OAuth requests expiring offline tokens (expiring=1). Access/refresh tokens, expiry times, and rotated replacements are encrypted locally. Check connection refreshes them when needed. The API version defaults to 2026-10; override with a supported stable SHOPIFY_API_VERSION.

Verification: a read-only GraphQL query for shop ID, name, myshopifyDomain, and currencyCode. No marketplace write occurs.

Official references:
- https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps
- https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant
- https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens
- https://shopify.dev/docs/api/admin-graphql/latest/queries/shop

## eBay

1. Create a developer app/keyset in eBay Developers Program. Start with Sandbox and a Sandbox seller account, not a production login.
2. Set EBAY_ENVIRONMENT=sandbox, EBAY_CLIENT_ID (App ID), and EBAY_CLIENT_SECRET (Cert ID). Production requires a Production keyset and EBAY_ENVIRONMENT=production.
3. In OAuth redirect settings / User Tokens, create a Redirect URL entry. Set its accepted URL to the exact HTTPS /oauth/ebay/return callback. Configure the declined URL and your valid privacy-policy URL as required by eBay.
4. Put the generated RuName in EBAY_RUNAME. Do not enter the literal callback URL there.
5. Enable/request sell.account.readonly for the seller-privileges connection check. No inventory-write or fulfillment-write scopes are requested by default.
6. Choose Connect eBay and approve on the official authorization page for the configured environment.

Verification: GET /sell/account/v1/privilege. The UI shows whether seller registration is complete. A new Sandbox seller can require seller setup even when OAuth is valid. Tokens refresh against the same environment's token endpoint. Environment/app changes require reconnecting.

Official references:
- https://developer.ebay.com/develop/guides/sell/authorization
- https://developer.ebay.com/api-docs/sell/account/resources/privilege/methods/getPrivileges

## Amazon

Private app (simplest for your own seller account):

1. Register an SP-API app in Amazon's supported developer console / Solution Provider Portal and request the roles needed for Sellers API access.
2. Set its LWA client ID and secret in AMAZON_CLIENT_ID and AMAZON_CLIENT_SECRET. These are not AWS IAM keys.
3. Self-authorize the private app in Amazon's console and obtain its refresh token.
4. Expand Amazon's Platform owner setup → Developer connection options and select Private app: self-authorized refresh token. Enter the seller ID and refresh token. The token is sent to Amazon for an access token, then encrypted locally.

Browser OAuth (public SP-API application):

1. Also set AMAZON_APPLICATION_ID (amzn1.sellerapps.app...).
2. Register the HTTPS /oauth/amazon/return redirect URI and HTTPS /oauth/amazon/login login URI displayed in the app.
3. Keep AMAZON_DRAFT=true for draft testing (version=beta), or false for the published version.
4. Click Connect Amazon to go directly to Seller Central and approve. If Amazon invokes the intermediate login URI, the app validates its continuation host/path and binds it to the flow started in your local browser.

Choose the matching AMAZON_REGION and AMAZON_MARKETPLACE. Examples: na/US, eu/UK, fe/JP. Other supported codes: CA, MX, BR, DE, FR, IT, ES, NL, SE, PL, BE, TR, AE, SA, IN, AU, SG. Mismatched region/marketplace pairs are rejected.

Verification: GET /sellers/v1/marketplaceParticipations on the regional SP-API host. The UI shows accessible marketplaces. App role approvals can block this read even after OAuth succeeds. Amazon's static-response Sandbox is not used as proof of actual seller authorization.

Official references:
- https://developer-docs.amazon.com/sp-api/docs/website-authorization-workflow
- https://developer-docs.amazon.com/sp-api/docs/self-authorization
- https://developer-docs.amazon.com/sp-api/reference/getmarketplaceparticipations

## Storage and disconnect

Tokens use AES-256-GCM authenticated encryption in data/commerce.sqlite. The per-install key is data/connection-key, or COMMERCE_TOKEN_KEY if configured. Keep both private. Encryption protects against exposure of the database alone, not compromise of your Windows account or theft of both files. Restore the original key if credentials become unreadable; do not regenerate it as a routine fix.

Client secrets stay in .env. The browser receives only readiness, safe errors, account labels, connection-check results, and callback addresses. It never receives tokens. No raw provider responses or tokens are logged. .env and data are ignored by Git.

Check connection makes an actual API read and refreshes expiring tokens when needed. Expired/invalid grants show Reconnect required. Network, rate-limit, or missing-scope/role errors remain visible for retry. Failed authorization does not replace an existing connection until a new valid token grant is obtained.

Disconnect locally deletes saved credentials and pending authorization attempts. It does not revoke the provider's grant or uninstall the app. Do that separately in the marketplace's connected-app settings. No automatic background API requests are scheduled.

## Validation limits

Automated tests use mocked provider responses for authorization, read checks, token refresh/rotation, browser binding, replay/expiry, callback signatures, domain validation, encrypted storage, public-route restrictions, and disconnect. They do not establish live authorization. Real testing needs your valid credentials, registered app URLs, seller permissions, and provider connectivity.

Run `npm run test:shopify-oauth` for the complete mocked browser journey from the seller form, through the official authorization URL and signed callback, to the verified account. It uses a separate in-memory database and test-only credentials, not your .env or accounts.

