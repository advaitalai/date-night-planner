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
import { config, testCallee } from "../config";
import type { Place } from "../types";

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
const slot = { date: "2026-10-16", time: "18:30", partySize: 2 };
const script = bookingScript(place, slot, contact, language);

console.log(`Calling ${callee.label} (${callee.phone}) in ${language === "ja" ? "Japanese" : "English"}. They answer as the restaurant (try: accept, say it's full, or ask for a course).`);
const call = await startCall(callee.phone, script);
const done = await waitForCall(call.id, 8 * 60_000, (s) => console.log(`  call ${s}`));
const transcript = done.artifact?.transcript ?? "";
console.log(`\nEnded: ${done.endedReason}\n\nTranscript:\n${transcript || "(none)"}`);
const outcome = await readOutcome(transcript, done.endedReason, `book ${slot.partySize} on ${slot.date} at ${slot.time}, seats only`);
console.log("\nWhat the bot understood:", JSON.stringify(outcome, null, 2));
if (done.artifact?.recordingUrl) console.log(`\nRecording: ${done.artifact.recordingUrl}`);
