# Settings (environment variables)

Set these in **Render > your service > Environment**. For local testing put them in a file called `.env` (never commit it).
After changing a setting in Render, save and let it redeploy.

## Required

| Name | What it is |
|---|---|
| `SUPABASE_URL` | your Supabase project address |
| `SUPABASE_SECRET_KEY` | your Supabase secret key (server only, never in the website code) |
| `NODE_ENV` | `production` on Render. In production there is no default admin password. |
| `ADMIN_PASSWORD` | the password for the first admin account (`admin@laidlaw.local`, or `ADMIN_EMAIL`). Only used the first time. |

## Strongly recommended

| Name | What it is |
|---|---|
| `ADMIN_SECRET` | a long random text. Without it, everyone is signed out every time the site restarts. |
| `AI_API_KEY` | your Anthropic key for the "Ask the mechanic" chat (without it the chat gives basic canned answers) |
| `CORS_ORIGIN` | leave **empty**. Only fill it (e.g. `https://your-other-site.com`) if another website or app must call your API. |
| `BUSINESS_NAME` | `AutoAid 24/7` |

## Shown on the Privacy Notice, Terms and call buttons

| Name | What it is |
|---|---|
| `LEGAL_NAME` | the registered name of the business, e.g. `AutoAid Ltd` (optional) |
| `CONTACT_EMAIL` | the email people can write to about their information (shown on both pages) |
| `SHOP_PHONE` | the shop phone number (shown on both pages and as "Call the shop" in the emergency panel) |

## Optional

| Name | Default | What it is |
|---|---|---|
| `ADMIN_EMAIL` | `admin@laidlaw.local` | email of the first admin account |
| `AI_MODEL` | `claude-opus-5-5` | which Claude model answers the chat (e.g. `claude-sonnet-5-5` is cheaper) |
| `AI_EFFORT` | `medium` | how hard the chat thinks: `low`, `medium`, `high` |
| `AI_HOURLY_LIMIT` | `40` | questions per customer per hour |

## Email verification codes (optional, off until you switch it on)

See **EMAIL.md**. A 6-digit code is emailed when customers and service providers sign up.

| Name | Example | What it is |
|---|---|---|
| `VERIFY_EMAIL` | `true` | turns the codes on (add it last) |
| `EMAIL_PROVIDER` | `brevo` or `resend` | which email service you use |
| `EMAIL_API_KEY` | from that service | keep private |
| `EMAIL_FROM` | `no-reply@yourdomain.com` | a sender you have verified with the service |
| `EMAIL_FROM_NAME` | `AutoAid 24/7` | the name people see (optional) |

## Parts ordering (optional, off until you switch it on)

Customers order parts from approved parts vendors in a chat. Customers collect the part from the vendor and pay the vendor in person; AutoAid's commission is
counted when the vendor marks the order picked up and paid, and the admin marks it settled in the **Parts** tab after the vendor pays it.

1. Run `schema-users.sql` in the Supabase SQL Editor (safe to run again). It adds the vendor account type and the order tables.
2. In Render > Environment add `PARTS_ENABLED` = `true` and save.
3. Vendors sign up from **Create account > I sell auto parts**. Approve them in the admin **Users** tab, like technicians.

| Name | Default | What it is |
|---|---|---|
| `PARTS_ENABLED` | off | turns parts ordering on |
| `PARTS_COMMISSION_PERCENT` | `3` | AutoAid's share of each completed parts order (0 to 50) |

## Vehicle rentals (optional, off until you switch it on)

Rental companies join as vendors ("I run a business", then tick **Vehicle rentals**), list vehicles with a daily rate (at least 3 days), and customers
request dates. Customers pay the company in person. AutoAid's commission is worked out on the rent (not the deposit) when the company accepts, counted when the
vehicle is returned, and settled by the admin in the **Parts & rentals** tab.

1. Run `schema-users.sql` in the Supabase SQL Editor (safe to run again).
2. In Render > Environment add `RENTALS_ENABLED` = `true` and save.

| Name | Default | What it is |
|---|---|---|
| `RENTALS_ENABLED` | off | turns vehicle rentals on |
| `RENTALS_COMMISSION_PERCENT` | `5` | AutoAid's share of each completed rental (0 to 50) |

Card on file is not built yet: it needs a payment provider that can save cards (see PAYMENTS.md). For now the customer agrees the company may charge for damage up to the deposit,
and the company takes the card or deposit at pick-up. Cars 10 years or older get a deposit of one day's rent if the company leaves the deposit blank.

## Payments

See **PAYMENTS.md** for the service provider subscription (`SUBSCRIPTIONS_ENABLED`, `SUBSCRIPTION_PRICE`, `FYGARO_*`, ...)
and Premium customers (`PREMIUM_ENABLED`, `PREMIUM_PRICE_MONTHLY`, `PREMIUM_PRICE_YEARLY`, `PREMIUM_PAY_OIL`, `PREMIUM_PAY_BRAKES`, ...).

## Database

Run `schema-users.sql` in the Supabase SQL Editor whenever it changes. It is safe to run again.

## Privacy Notice and Terms

The pages are `public/privacy.html` and `public/terms.html`. They are plain-language drafts that describe what the app really does.
**Have them checked by a lawyer in Jamaica before relying on them**, and decide your own refund policy (the Terms currently say refunds are
considered case by case). When you change them in a way people should agree to again, change `TERMS_VERSION` in `auth.js`.
