/**
 * Sample AI booking call to yourself: you play the restaurant.
 *
 *   npm run test-call -- [ja|en] [emily|advait|<number>]
 *
 * Calls BOOKING_PHONE (or the person/number given, else CALL_TEST_TO) through
 * Vapi with the same booking script the bot uses for real restaurants, then
 * prints the transcript and the outcome the bot would act on. Needs
 * VAPI_API_KEY and VAPI_PHONE_NUMBER_ID.
 */
import { bookingScript, readOutcome, startCall, vapiConfigured, waitForCall, type CallLanguage } from "../booking/phone";
import { flushCloudLogs, startCloudLogging } from "../cloudlog";
import { config, testCallee } from "../config";
import { getPrefs } from "../db/repo";
import { logToFile } from "../logbook";
import type { Place } from "../types";
import { nextWeekday, now } from "../util/time";

// Into the log files and (on the server) Cloud Logging, so Claude can read the test too.
logToFile();
await startCloudLogging();

const args = process.argv.slice(2);
const language = (args.includes("en") ? "en" : "ja") as CallLanguage;
const callee = testCallee(args.find((a) => a !== "en" && a !== "ja") ?? config.call.testTo);
if (!vapiConfigured()) {
  console.error("Set VAPI_API_KEY and VAPI_PHONE_NUMBER_ID in .env first (see docs/SETUP.md, 'AI phone calls').");
  process.exit(1);
}
const contact = config.booking.contact;
if (!callee.phone) {
  console.error(`No number to call for "${callee.label}". Set BOOKING_PHONE, or EMILY_PHONE / ADVAIT_PHONE for a person, in .env.`);
  process.exit(1);
}

// A pretend restaurant; you answer as the restaurant.
const place = { name: language === "ja" ? "テスト食堂" : "Test Trattoria", phone: callee.phone } as Place;
// The next usual date night (it used to be a fixed date, 16 Oct, which had passed by the 20th).
const slot = { date: nextWeekday(now(), getPrefs().defaultWeekday), time: getPrefs().defaultTime, partySize: 2 };
const script = bookingScript(place, slot, contact, language);

console.log(`[test-call] for ${slot.date} ${slot.time}, ${slot.partySize} people`);
console.log(`Calling ${callee.label} (${callee.phone}) in ${language === "ja" ? "Japanese" : "English"}. They answer as the restaurant (try: accept, say it's full, or ask for a course).`);
const call = await startCall(callee.phone, script);
const done = await waitForCall(call.id, 8 * 60_000, (s) => console.log(`  call ${s}`));
const transcript = done.artifact?.transcript ?? "";
console.log(`\nEnded: ${done.endedReason}\n\nTranscript:\n${transcript || "(none)"}`);
const outcome = await readOutcome(transcript, done.endedReason, `book ${slot.partySize} on ${slot.date} at ${slot.time}, seats only`);
console.log("\nWhat the bot understood:", JSON.stringify(outcome, null, 2));
if (done.artifact?.recordingUrl) console.log(`\nRecording: ${done.artifact.recordingUrl}`);
await flushCloudLogs();
