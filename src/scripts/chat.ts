/**
 * Talk to the planner in the terminal instead of WhatsApp: same agent, same
 * tools, group messages are printed here. Also serves the onboarding page on
 * http://localhost:8080 so Google can be connected locally.
 *
 *   npm run chat            (you are Advait)
 *   npm run chat -- Emily
 */
import readline from "node:readline/promises";
import { handleMessage } from "../agent/loop";
import { closeBrowsers } from "../booking/browser";
import { config, PEOPLE } from "../config";
import { logMessage } from "../db/repo";
import { onboardingLink, startWebServer } from "../web/server";

const person = process.argv[2] ?? "Advait";
if (!PEOPLE.includes(person as never)) throw new Error(`person must be one of ${PEOPLE.join(", ")}`);

await startWebServer().catch((err) => console.warn("web server not started:", (err as Error).message));
console.log(`Chatting as ${person} (DRY_RUN=${config.dryRun ? "on: nothing is really booked" : "OFF: bookings are real"}).`);
console.log(`Google connect link: ${onboardingLink(person)}`);
console.log('Try: "plan wednesday", "book option 1", "list reservations". Ctrl+C to quit.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("close", async () => {
  await closeBrowsers();
  process.exit(0);
});
for (;;) {
  const text = (await rl.question(`${person}> `)).trim();
  if (!text) continue;
  logMessage(person, text);
  try {
    const reply = await handleMessage(person, text);
    if (reply) {
      logMessage("planner", reply);
      console.log(`planner: ${reply}\n`);
    }
  } catch (err) {
    console.error("error:", err);
  }
}
