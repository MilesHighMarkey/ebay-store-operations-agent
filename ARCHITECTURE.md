# Store agent architecture

## Current working boundary

`server.mjs` provides a local API boundary and serves the dashboard. It is deliberately mock-first:

- `GET /api/status` exposes connection state and live-action gates.
- `GET /api/approvals` reads the approval queue.
- `POST /api/approvals` records an approval request without publishing or buying anything.
- `MOCK_MODE=false` is reserved for the future connector implementation; it does not enable live mutations by itself.

## Connector contracts to implement next

- `EbayAdapter`: OAuth authorization, inventory reads, listing drafts, order reads, tracking reads, seller-health reads. Mutations must require an approved action id.
- `SupplierAdapter`: normalized product, stock, cost, shipping, handling, transit, source-location, and supplier-authorization data.
- `MarketAdapter`: competitor/product signals from permitted APIs or user-provided exports; never scrape private accounts or bypass access controls.
- `TelegramApprovalAdapter`: send a compact approval card and verify callback/action id before any sensitive mutation.

OAuth tokens are encrypted with AES-256-GCM in `.ebay-token.enc` using `TOKEN_ENCRYPTION_KEY`. The token file is local-only and should never be committed.

## Safety invariant

No adapter may publish, reprice, end a listing, purchase stock, send a buyer message, issue a refund, or upload tracking unless the action has an explicit approved action id and an audit record.

The first read-only endpoints are available at `/api/ebay/inventory` and `/api/ebay/orders`. They return a disconnected response until an encrypted OAuth token is present.

Normalized read-only views are available at `/api/ebay/inventory/normalized` and `/api/ebay/orders/normalized` for dashboard and profit calculations.

`GET /api/dashboard` returns the consolidated local agent snapshot for the dashboard and approval channel.

`GET /api/setup/status` reports integration readiness and missing configuration names without revealing secret values.

`POST /api/sync/ebay` performs a read-only inventory/open-order sync and stores a local snapshot when OAuth is connected. It returns a disconnected response otherwise.

`POST /api/opportunities/score` accepts sale price, supplier cost, supplier shipping, monthly sales, supplier speed, stock confidence, and competition signals. It returns profit, projected monthly profit, a 0–100 score, and a review/reject decision. It is advisory only and never publishes or purchases.

`POST /api/listing-drafts` creates a reviewable listing draft with title, description, shipping-included price, handling/transit estimates, item specifics, and risk flags. It never calls an eBay write endpoint.

Monitoring endpoints: `POST /api/monitor/health` evaluates seller metrics and returns alerts; `POST /api/monitor/deadlines` identifies urgent or overdue ship-by orders. These are read/alert operations only.

`POST /api/market/signals` scores permitted market evidence such as 30-day sales, views, watchers, and competitor count. It accepts user/API-provided evidence only; it does not scrape private stores or bypass access controls.

`POST /api/suppliers/rank` ranks source offers by landed cost, handling plus transit time, stock confidence, and supplier authorization. Ineligible suppliers are marked and never selected automatically.

`GET/POST /api/suppliers/catalog` reads or imports supplier offers into durable local state. Imported offers are data only until ranked and approved.

`POST /api/pricing/recommend` calculates a shipping-included competitive price while preserving the target profit, with the high-volume exception available when market price supports it.

`POST /api/profit/report` reconciles order revenue, eBay fees, supplier costs, supplier shipping, and per-order profit. The summary can be grouped into monthly or quarterly periods by the caller.

Approval channels can call `POST /api/approvals/{id}/decision` with `X-Approval-Secret` and `{ "decision": "approved" | "rejected" }`. This records the decision but does not yet execute a marketplace mutation.

Approval creation also calls the Telegram adapter. Without bot credentials it returns a dry-run card; with credentials it sends a notification but still requires the protected decision endpoint before any future mutation.

Approval records, drafts, and connector status are persisted locally in `.agent-state.json`, which is excluded from version control.
