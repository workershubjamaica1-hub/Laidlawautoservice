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

---

# Premium (one yearly membership for each vehicle)

A customer joins **AutoAid Premium for one vehicle**. The yearly price depends on the type of vehicle:

| Vehicle type (what the customer chose when adding it) | Yearly price |
|---|---|
| Car | J$12,000 |
| SUV or van | J$18,000 |
| Pickup or small truck (light truck, small truck) | J$25,000 |
| Large truck or bus (heavy truck, bus) | J$50,000 |

Motorcycles and "other" vehicles are not covered.

Each membership year gives **2 services** for that vehicle. A service is a **diagnostic check followed by servicing** (an oil and filter change),
done by a technician. **AutoAid provides the technician. The customer supplies the oil and filter**, or agrees a price with the technician in the
job chat if the technician supplies them (the technician records it as the job amount). Services must be at least 60 days apart.

Premium can be paid **by card (Fygaro)** or **by bank transfer**. While Fygaro is paused, bank transfer is the way:

1. In the admin portal, **Users > Settings > Bank details**, type the account customers should pay into.
2. The customer taps **Join Premium by bank transfer** on the Premium page and sees the amount, your bank details and a reference (like AA-12-X7K). They pay with that reference and can upload a photo of the receipt.
3. You get an email, and the payment shows on the Overview under **Payments to confirm**. When the money is in your account, press **Confirm**: the vehicle becomes Premium for a year and the customer is emailed. Press **Reject** (with a reason) if it never arrived.

Card payment uses the same Fygaro account, button and keys as the other online payments (see above).
It is **off** until you set `PREMIUM_ENABLED=true`, and a vehicle type is only offered when it has a price.

## How it works for the customer

1. **Premium** page lists the customer's vehicles. Each shows its price (for example *J$12,000 for 12 months*) and a **Join Premium for this vehicle** button. They pay by card on Fygaro's page.
2. When the payment goes through, that vehicle shows **Member**, with *0 of 2 used*. Paying again adds another year.
3. **Book a free service** creates a normal job marked **Premium** (category: maintenance). A technician takes it and chats with the customer.
4. Cancelling a booking gives the service back. Unused services do not carry over to the next year.

## What the technician is paid

For each Premium service the customer confirms, AutoAid pays the technician the **fixed amount for that vehicle type** (settings below).
It shows in **Fees & orders > Technician payouts** (with the technician's bank details): pay them by bank transfer and press **Mark paid**.
It is added to the technician's earnings. There is no AutoAid fee on a Premium service. Anything the customer pays the technician for oil, filter or parts is separate (in person).

## Render settings for Premium

| Name | Value to use | What it is |
|---|---|---|
| `PREMIUM_ENABLED` | `true` | turns Premium on |
| `PREMIUM_PRICE_CAR` | `12000` | yearly price for a car |
| `PREMIUM_PRICE_SUV` | `18000` | yearly price for an SUV or van |
| `PREMIUM_PRICE_SMALL_TRUCK` | `25000` | yearly price for a pickup or small truck |
| `PREMIUM_PRICE_LARGE_TRUCK` | `50000` | yearly price for a large truck or bus |
| `PREMIUM_PAY_CAR` | your amount | what AutoAid pays a technician for ONE service on a car |
| `PREMIUM_PAY_SUV` | your amount | the same for an SUV or van |
| `PREMIUM_PAY_SMALL_TRUCK` | your amount | the same for a pickup or small truck |
| `PREMIUM_PAY_LARGE_TRUCK` | your amount | the same for a large truck or bus |
| `PREMIUM_SERVICES_PER_YEAR` | `2` | services in each membership year (optional, default 2) |
| `PREMIUM_SERVICE_GAP_DAYS` | `60` | minimum days between two services on one vehicle (optional, default 60) |

Do not switch Premium on until every vehicle type that has a price also has a technician pay amount (the admin page warns you if one is missing).
Premium payments reach the site through the same Hook URL as every other payment (reference `premv-<vehicle>-<customer>-<time>`).

## What you see as admin

* **Users > Settings** shows the four prices, what technicians are paid, and how many vehicles are members.
* **Vehicles** shows each vehicle's membership and has **Add Premium days** (cash payments, gifts, or fixing a missed payment).
  **Recent payments** shows Premium payments too.

## Turning off the fees

To stop charging fees, set `JOBS_FEE_PERCENT`, `PARTS_COMMISSION_PERCENT` and `RENTALS_COMMISSION_PERCENT` to `0` in Render. Everything keeps working and the screens show no fee.
Without any fee, online payment for ordinary jobs, parts and rentals only costs you card charges and admin work, so leave `JOBS_ONLINE_PAYMENT`,
`PARTS_ONLINE_PAYMENT` and `RENTALS_ONLINE_PAYMENT` off (people pay in person) and use Fygaro only for Premium.

# Paying for repair jobs online (Fygaro)

When this is on, a customer pays when they agree a technician's price, **AutoAid holds the money**, and after the customer confirms the job
you pay the technician **price minus your fee** (default 5%) by bank transfer. If the job does not go ahead, you refund the customer.
It uses the same Fygaro account and the same three settings as the subscription (`FYGARO_BUTTON_URL`, `FYGARO_KEY_ID`, `FYGARO_SECRET`).
It is **off** until you set `JOBS_ONLINE_PAYMENT=true`. While it is off, customers pay technicians in person and technicians owe you the fee.

## Setup

1. Make sure the three Fygaro settings from the section above are in Render (Key ID, Secret, and the button URL). Currency must be JMD
   (`SUBSCRIPTION_CURRENCY`, default JMD).
2. In Fygaro, the payment **Hook URL** must be `https://autoaid247.com/webhooks/fygaro` (https, your own domain).
3. In Render add `JOBS_ONLINE_PAYMENT` = `true` and save.
4. Run `schema-users.sql` in Supabase (safe to run again) if you have not.
5. **Test with a small job:** have a technician send a price of J$100, pay it with a real card, and watch the job turn "Booked". Then cancel it
   and check it appears under **Fees & orders > Refunds to make**; refund it in Fygaro and press **Mark refunded**.

## Day to day (admin: Fees & orders tab)

* **Technician payouts**: jobs the customer paid for and confirmed. It shows the amount, and the bank details the technician saved in My account.
  Send the transfer from your bank, then press **Mark paid**.
* **Refunds to make**: paid jobs that were cancelled, or payments that did not match a price. Refund in your Fygaro dashboard (the Fygaro
  transaction number is shown), then press **Mark refunded**.
* **Customer complaints**: a customer reported a problem before confirming. The payment is held. Talk to both people, then press
  **Pay the technician** or **Refund the customer**.
* Fygaro takes its own fee from each payment. Your 5% job fee is what is left to you after paying the technician, so check that it covers Fygaro's charge.

## If something looks wrong

* Customer paid but the job is still "Price sent": check Render logs for `Fygaro webhook rejected: bad signature` (Key ID or Secret do not match),
  or `could not be used` (the amount or job changed; it is queued under Refunds to make).
* You can always see every Fygaro payment in the Fygaro dashboard, with the reference `job-<job number>-<time>`.

## Rentals paid through the app

Set `RENTALS_ONLINE_PAYMENT=true` (with the Fygaro settings above) to take rental payments online.

1. The renter asks for a vehicle. The company accepts. The booking now shows **Pay J$... securely**: rent plus deposit in one payment, on a signed Fygaro link (reference `rent-<booking>-<time>`, same Hook URL as every other payment).
2. When Fygaro reports the payment, the booking shows **Paid**. The company cannot mark the vehicle handed over until it is paid.
3. After the return check is settled (the renter agrees, or 3 days pass, or you decide a dispute), the app works out:
   * **Company payout** = rent − AutoAid commission + late fee taken from the deposit + any amount you decide to keep from the deposit.
   * **Renter refund** = deposit − the late fee taken − the amount kept.
4. In **Fees & orders**, **Rental returns to review** lists *Pay (company) J$...* with their bank details, and *Refund J$... to (renter)* with the Fygaro transaction number. Pay the company by bank transfer, then press **Mark paid**. Refund the renter in the Fygaro dashboard, then press **Mark refunded**.
5. If a paid booking is cancelled before pick-up, the full amount shows as a refund to send.
6. Companies add their bank details in **My account** (How should we pay you?).

When you decide a dispute, the form asks how much of the deposit the company keeps (0 to refund it all).

Card holds: Fygaro offers **Manual Capture** (a hold on the card instead of a charge) on some plans. The app does not use it yet: the deposit is charged and then refunded. Ask Fygaro whether Manual Capture works with signed links before we change this.

## Parts and accessories paid through the app

Set `PARTS_ONLINE_PAYMENT=true` (with the Fygaro settings above).

1. The customer accepts the seller's offer (for accessories, the total includes any fitting charge). The order now shows **Pay J$... securely** on a signed Fygaro link (reference `part-<order>-<time>`, same Hook URL).
2. When Fygaro reports the payment the order shows **Paid**. The seller cannot mark it handed over or fitted until it is paid.
3. After the seller marks it done, the customer is asked to **confirm they are happy**. If they do not answer in 3 days it is confirmed for them. Then the seller's payout is the price less the commission (3% by default).
4. If the customer **reports a problem**, the money stays held. In **Fees & orders**, *Parts and accessories to settle* shows the problem with both phone numbers: call both, open the order, and press *Decide: pay the seller* or *Decide: refund the customer*, with a note.
5. In the same list: *Pay (seller) J$...* with their bank details (press **Mark paid** after you transfer it), and *Refund J$... to (customer)* with the Fygaro transaction number (refund in Fygaro, then **Mark refunded**).
6. A paid order that is cancelled before it is handed over shows as a full refund to send.
7. Sellers add their bank details in **My account**.
