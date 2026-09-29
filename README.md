# eBay Store Operations Agent MVP

Standalone local prototype for product vetting, profit analysis, supplier-speed scoring, and approval-gated store operations.

## Run

On Windows, double-click **Start Store Agent.vbs**. It starts the service without opening a terminal and opens the connected dashboard automatically.

For the dashboard only, open `index.html` in a browser. For the API-backed version, run:

```text
copy .env.example .env
npm start
```

Then open `http://localhost:8789/`. The server runs in mock mode until eBay credentials are configured.

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

To connect eBay, create an eBay developer application, set its redirect URI to the value in `.env`, add `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, and a strong `TOKEN_ENCRYPTION_KEY`, then visit `/auth/ebay/start`. The resulting token is stored locally and the agent remains read-only.

## MVP rules

- Default target profit is $10 per sale.
- High-volume exceptions are allowed when projected monthly profit is strong.
- Shipping is included in the buyer-facing price calculation.
- Supplier handling and transit are modeled separately.
- Publishing, repricing, purchasing, refunds, and listing removal require approval.
