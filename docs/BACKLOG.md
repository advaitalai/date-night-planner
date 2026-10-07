# Product backlog

The MVP covers the items in "Done" below. Everything else is ordered roughly by value. Each entry says what it is, why it matters and any known constraint.

## Next up

1. **Verify the booking flows on the live sites.** Do a dry run, then one real booking and cancellation each on TableCheck and Tabelog. The browser steps use text and role locators, but they still need to be tuned against the real pages. Keep `DRY_RUN=1` until each flow has been seen working end to end.
2. **Run the bookability audit on both lists** (`npm run audit`). Use the result to prioritise the items below: how many places take phone bookings only, and how many use other platforms.
3. **👍 / 👎 rating cards after each date** (phase 2). This could be a WhatsApp poll the morning after ("How was X?"), stored in `visits.rating`. Ratings would then:
   - boost similar places in scoring;
   - stop places rated 👎 from being suggested again;
   - feed the cuisine rotation.

## Booking coverage

- **TableCheck newer flow** (`/reserve/message` → landing → menu): finish the booking steps. The flow is mapped in REQUIREMENTS §7. Kuss Daikanyama, TUITUI and Taro Yamada use it.

4. **AI phone calls for phone-only restaurants.** This is common in Tokyo. It needs a Japanese voice agent (Twilio plus a realtime voice model) that:
   - makes the call;
   - confirms the date, time and number of people;
   - asks about the cancellation policy;
   - writes the outcome back to the reservation.

   AutoReserve (Hello Inc.) offers this as a consumer app, but it has no public API.
5. **More booking platforms:** Hot Pepper Gourmet (its search API is free; booking would go through the browser), OMAKASE, ebica, Toreta and Ikyu. `detect.ts` already marks these places as `other_online`.
6. **Contact forms:** some restaurants offer a web form but no email address. Fill the form with the same Japanese template.
7. **Watch fully booked places for cancellations.** Poll TableCheck availability for places they both want that are full, and book automatically when a table frees up.
8. **Book sought-after places further ahead.** For places that fill up weeks in advance, book further out than the Saturday-before rhythm.

## Planning & recommendations

9. **Google Calendar invites** for both people when a booking is confirmed. Update or remove the invite when the booking changes or is cancelled.
10. **Non-dinner date ideas** from the saved lists (spa, gallery, cafés), e.g. "Saturday afternoon plan".
11. **A "midway" anchor:** somewhere between home and the office, or between two places where they'll be that day.
12. **Learn preferences from chat:** turn "too loud", "loved the counter seats" into vibe weights.
13. **Weather-aware suggestions:** terrace places only when it's dry and mild.

## Platform

14. **Official WhatsApp Business API,** if Meta's group-chat support becomes generally available. That would remove the risk of the unofficial library getting the bot's number banned.
15. **Admin page:** reservations, jobs, places and their booking channels, with manual overrides (e.g. fix a wrong TableCheck slug).
16. **Encrypt the Google tokens** stored in SQLite at rest.

## Done (MVP)

- WhatsApp group bot with an agent loop, and polls for voting.
- Saved lists: Takeout CSV import, automatic import of recurring Takeout exports from Drive, and Maps links pasted in chat.
- Recommender:
  - parses free-text requests;
  - starts from home or the office;
  - rotates cuisines;
  - finds places similar to a named one;
  - discovers places beyond the saved lists;
  - checks availability before proposing;
  - writes pitches using only stored facts.
- Booking through TableCheck, Tabelog and email: book, change and cancel. Cancellation policies are read from the booking and turned into deadline reminders.
- Weekly rhythm:
  - Saturday kickoff and Sunday nudge;
  - books the top-voted option on Sunday evening;
  - "still on?" checks 48h and 24h before the free-cancellation deadline;
  - reminder on the day;
  - visit log after the date.
- Bookability audit script.
