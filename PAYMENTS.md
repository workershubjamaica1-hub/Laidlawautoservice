# Monthly subscription for service providers (Fygaro)

Service providers pay a monthly fee after an admin approves them. Until they pay, they can sign in but cannot see customers,
emergency requests or jobs. Everything is **off** until you set `SUBSCRIPTIONS_ENABLED=true`, so nothing changes for anyone until you are ready.

## How it works

1. A provider applies, you approve them in **Users**.
2. When they sign in they see **Activate your account** with a **Pay J$... now** button.
3. The button opens Fygaro's payment page. The amount is signed into the link, so it cannot be changed.
4. After they pay, Fygaro sends our server a signed "payment received" message. The site checks the signature and the amount,
   then gives the provider `SUBSCRIPTION_DAYS` days of access (default 30). Paying early adds to the end date.
5. In the last 7 days, and during the grace period, the provider sees a **Renew now** reminder.
6. After the paid date plus `SUBSCRIPTION_GRACE_DAYS` (default 5) with no payment, access stops until they pay again.

Customers only see technicians whose subscription is in good standing.

## What you need from Fygaro

* A Fygaro merchant account. **Signed payment links and payment notifications need Fygaro's Pro plan or higher.**
* Ask Fygaro to confirm **JMD** is supported on your account, and their current fees and when money reaches your bank.

## Setup, in order

1. **Database.** Run `schema-users.sql` in the Supabase SQL Editor (it is safe to run again).
2. **Fygaro API credentials.** In Fygaro: *Settings > API Credentials > Generate New*. Save the **Key ID** and the **Secret**.
   The secret is shown only once.
3. **Payment button.** Create a payment button/link in Fygaro and copy its URL. Under the button's *Edit > Advanced Options* set the
   **Hook URL** to `https://YOUR-SITE.onrender.com/webhooks/fygaro` (it must be https). If Fygaro lets you set a return/redirect
   address for the button, use `https://YOUR-SITE.onrender.com/admin.html?paid=1` so providers land back on the site and unlock
   automatically.
4. **Render settings.** In Render > your service > Environment add:

   | Name | Example | What it is |
   |---|---|---|
   | `SUBSCRIPTIONS_ENABLED` | `true` | turns subscriptions on |
   | `SUBSCRIPTION_PRICE` | `5000` | the monthly fee |
   | `SUBSCRIPTION_CURRENCY` | `JMD` | must match the Fygaro button |
   | `SUBSCRIPTION_DAYS` | `30` | days one payment covers |
   | `SUBSCRIPTION_GRACE_DAYS` | `5` | extra days after the date before access stops |
   | `FYGARO_BUTTON_URL` | the URL from step 3 | |
   | `FYGARO_KEY_ID` | from step 2 | |
   | `FYGARO_SECRET` | from step 2 | keep private, never put it in the code |

   (While changing keys you can keep the old secret in `FYGARO_SECRET_OLD`; both are accepted.)
5. **Existing technicians.** Switching subscriptions on would lock out technicians who joined before it existed. Right after
   enabling, open **Users** and press **Give them 30 free days**. New technicians then pay as normal.
6. **Test it.** Make a test provider, approve them, sign in as them, and pay. To avoid a large charge, temporarily set
   `SUBSCRIPTION_PRICE` to a very small amount, pay, confirm the provider unlocks, then put the real price back.
   You can refund the test payment in Fygaro.

## Day to day

* **Users tab** shows each provider's status ("Paid until ...", "Expired ...", "not paid") and has **Add days** for cash/bank
  payments, free months, or fixing a problem. The **Recent subscription payments** list shows every payment.
* If a provider says they paid but are still locked, check the Render logs:
  * `Fygaro webhook rejected: bad signature` means the Key ID/Secret do not match the ones in Fygaro.
  * `not credited: got ... expected ...` means the amount or currency on the Fygaro button does not match your settings.
  * Nothing at all means Fygaro did not reach the Hook URL: re-check step 3. Meanwhile use **Add days** so they can work.

## Important limits

* **This is not automatic card-on-file billing.** Fygaro's published developer docs describe one-off payment links and payment
  notifications, not recurring charges. So each month the provider taps **Renew now** and pays again; the site extends their
  access automatically. Ask Fygaro support whether they offer recurring billing; if they do, tell us and we can adapt.
* **No email or SMS reminders yet.** The reminder shows inside the portal only.
* Fygaro's documents do not say whether they retry a notification that fails. The site always records a payment only once
  (a repeated notification is ignored), and **Add days** is the manual backup.
* Check taxes, your terms for providers, and your refund policy before charging. We are not able to advise on that.
