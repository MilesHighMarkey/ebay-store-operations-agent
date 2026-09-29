# eBay Store Operations Agent MVP

Standalone local prototype for product vetting, profit analysis, supplier-speed scoring, and approval-gated store operations.

## Run

On Windows, double-click **Start Store Agent.vbs**. It starts the service without opening a terminal and opens the connected dashboard automatically.

For the dashboard only, open `index.html` in a browser. For the API-backed version, run:

```text
copy .env.example .env
npm start
```

Then open `http://localhost:8787/` (or double-click the Windows launcher, which uses port 8789). The server runs in mock mode until eBay credentials are configured.

Useful checks:

```text
GET  /api/dashboard
GET  /api/ebay/inventory/normalized
GET  /api/ebay/orders/normalized
POST /api/opportunities/score
POST /api/suppliers/rank
POST /api/pricing/recommend
POST /api/profit/report
POST /api/listing-drafts
POST /api/approvals
```

To connect eBay, create an eBay developer application, configure its OAuth-enabled RuName to return to `/auth/ebay/callback`, and set `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_REDIRECT_URI` (the eBay RuName), and a strong `TOKEN_ENCRYPTION_KEY` in Render or the local `.env`. Use the dashboard's **Authorize eBay read-only access** button. The callback exchanges the authorization code automatically and stores the token encrypted; live mutations remain disabled by default.

For permitted AliExpress catalog discovery, add `ALIEXPRESS_APP_KEY`, `ALIEXPRESS_APP_SECRET`, and optionally `ALIEXPRESS_TRACKING_ID`. The dashboard's read-only search uses the official product-query endpoint, sends U.S. destination and delivery filters, and scores the returned candidates before they enter review. It does not scrape pages, place supplier orders, or publish listings.

## MVP rules

- Default target profit is $10 per sale.
- High-volume exceptions are allowed when projected monthly profit is strong.
- Shipping is included in the buyer-facing price calculation.
- Supplier handling and transit are modeled separately.
- Publishing, repricing, purchasing, refunds, and listing removal require approval.
- Automatic AliExpress discovery runs on the server at startup and periodically, using the official API only; invalid credentials and response-shape errors are shown in discovery diagnostics.
