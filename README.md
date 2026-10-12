# PG ERP

A management platform for running PG / hostel properties: rooms and beds, tenants, monthly rent
billing, payments, expenses, maintenance and reports, with staff logins and roles.

No dependencies to install. Requires **Node 22.5+** (uses the built-in `node:sqlite`).

## Run

```
cd erp
npm start            # http://localhost:4000
npm run demo         # optional: load sample data into an EMPTY database
npm test             # backend test suite
```

On first start an admin account is created and its **random password is printed once** in the
console (email `admin@pg.local`). Sign in, then use *Change password* and add your staff under *Users*.
To choose the credentials yourself, set `ERP_ADMIN_EMAIL` and `ERP_ADMIN_PASSWORD` before the first start.

## Modules

| Module | What it does |
| --- | --- |
| Dashboard | Occupancy, billed / collected / outstanding / overdue, net for the month, 6-month trend, highest dues |
| Properties & Rooms | Buildings, rooms with bed count, AC/Non-AC and rent per bed; occupancy per room |
| Tenants | Onboarding with bed-capacity checks, deposit, ID proof, check-out with dues warning, per-tenant ledger |
| Invoices | One-click monthly rent generation (idempotent), manual invoices (e.g. late fee), status paid / partial / unpaid / overdue |
| Payments | Part-payments by cash/UPI/bank/card; overpayment blocked; admin-only reversal |
| Expenses | Categorised, per property or general |
| Maintenance | Tickets with priority and open → in progress → resolved |
| Reports | Rent roll, outstanding dues, profit & loss, occupancy; each downloadable as CSV |
| Users & Audit log | Admin-only user management and a log of who changed what |

## Roles

- **Admin**: everything, including users, audit log and reversing payments
- **Manager**: properties, rooms, tenants, maintenance; read-only on finance
- **Accountant**: invoices, payments, expenses; read-only on property data

## Security notes

- Passwords hashed with scrypt; sessions are random tokens stored hashed server-side, in an
  `HttpOnly; SameSite=Strict` cookie, expiring after 8 hours and revoked on password change or deactivation
- Login throttling (5 failures → 5 minute lockout per IP + email)
- Every endpoint is permission-checked on the server; the UI only hides what you cannot use
- Strict Content-Security-Policy, cross-origin write blocking, parameterised SQL, CSV formula neutralisation
- Listens on `127.0.0.1` only by default. To expose it, put it behind HTTPS (reverse proxy), set
  `HOST=0.0.0.0` and `ERP_SECURE_COOKIE=1`

## Data

SQLite database at `data/erp.db` (override with `ERP_DATA_DIR`). Back it up by copying the file while the server is stopped.
Amounts are whole rupees. Rent is billed per full calendar month (no proration).

## API

JSON under `/api/*` (see `lib/api.js` for the route table): `login`, `logout`, `me`, `password`, `dashboard`,
`properties`, `rooms`, `tenants` (+ `/:id/checkout`), `invoices` (+ `/generate`), `payments`, `expenses`,
`tickets`, `users`, `audit`, `reports/:name[?format=csv]`.
