# Email verification codes (sign-up)

When this is switched on, **customers and service providers** get a 6-digit code by email when they sign up (or apply).
They type it in to prove the email is theirs:

* **Customers** are signed in as soon as the code is right.
* **Service providers** must verify their email first, then their application waits for admin approval as before. The admin
  only sees an application in the approval list once its email is verified.
* Anyone who signed up but never verified is sent to the code screen the next time they try to sign in, and can ask for a new code.
* **Everyone who already has an account counts as verified**, so nothing changes for them.

It is **off** until you set `VERIFY_EMAIL=true`, so you can finish the setup first.

## Why we need an email service

The site cannot send email by itself. And Render's free plan blocks the normal email ports (25, 465 and 587), so we send through an
email service's web API instead. The site supports two: **Brevo** and **Resend**. Both have a free plan
(Brevo: about 300 emails a day; Resend: about 100 a day and 3,000 a month; check their sites for current limits).
Each sign-up uses one email, plus one for every "send me a new code".

## The one thing you must have: a sender you can prove you own

Both services make you prove you own the address or domain emails come from. **A free Gmail/Yahoo address is a poor sender:**
messages that say they come from Gmail but are sent through another service are often blocked or put in spam.
The reliable way is a **domain you own** (for example `autoaidja.com`, usually a few US dollars a year from any domain seller) and a
sender such as `no-reply@autoaidja.com`.

* **Resend** only delivers to other people once you have verified a domain with them.
* **Brevo** also steers you to verify a domain. Check in your Brevo account whether it will let you verify a single sender address;
  either way, a domain gives much better delivery.

## Setup, in order

1. **Database.** Run `schema-users.sql` in the Supabase SQL Editor (safe to run again). This adds the code columns.
2. **Create an account** with Brevo (brevo.com) or Resend (resend.com).
3. **Verify your domain/sender.** Add the DNS records the service shows you at the place you bought the domain, then wait for it to
   say "verified" (minutes to a few hours).
4. **Create an API key** in the service. Copy it; it is usually shown only once.
5. **Render settings.** In Render > your service > Environment add:

   | Name | Example | What it is |
   |---|---|---|
   | `EMAIL_PROVIDER` | `brevo` or `resend` | which service you use |
   | `EMAIL_API_KEY` | the key from step 4 | keep private |
   | `EMAIL_FROM` | `no-reply@yourdomain.com` | must be the verified address |
   | `EMAIL_FROM_NAME` | `AutoAid 24/7` | the name people see (optional) |
   | `VERIFY_EMAIL` | `true` | switches the codes on. Add this last. |

   Optional: `EMAIL_CODE_TTL_MINUTES` (how long a code lasts, default 10) and `EMAIL_RESEND_SECONDS` (wait before another code, default 60).
6. **Test it.** Sign up as a customer with your own email. The code should arrive within a minute (check spam). Try a wrong
   code, then the right one.

## If something goes wrong

* **"Email verification is not set up yet"** when someone signs up: `VERIFY_EMAIL` is `true` but `EMAIL_PROVIDER`,
  `EMAIL_API_KEY` or `EMAIL_FROM` is missing or wrong. Fix it, or set `VERIFY_EMAIL` back to `false`.
* **The sign-up says it could not send the email:** open Render's **Logs** and look for
  `Could not send the verification email: ...`. It names the problem, for example a wrong API key or an address that is not verified.
  The person can tap **Send a new code** once it is fixed.
* **The code goes to spam:** this is the sender problem above. Use a domain you own and make sure its DNS records are verified.
* **Someone cannot get their code:** in the admin **Users** tab, press **Verify email** next to them (or open
  "waiting for email verification" for applicants and press **Mark email verified**).

## How it protects people

* Codes are 6 digits, last 10 minutes, and **only a scrambled copy is stored**.
* 5 wrong tries lock that code; they must ask for a new one (at most one every minute, and a limit per hour).
* Lots of wrong guesses from one place are blocked.
* If someone signs up with another person's email, the real owner can simply sign up again; the unverified sign-up is replaced.
* Asking for a code never reveals whether an email has an account.

Sources: [Render: free web services no longer allow outbound SMTP](https://render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports),
[Brevo](https://www.brevo.com/features/email-api/), [Resend limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits).
