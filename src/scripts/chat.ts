/**
 * Talk to the planner in the terminal instead of WhatsApp: same agent, same
 * tools, group messages are printed here. Every line you type counts as
 * addressed to the bot; start a line with "~" to say it to the other person
 * instead (the bot only listens, as in the group).
 *
 *   npm run chat            (you are Advait)
 *   npm run chat -- Emily
 */
import readline from "node:readline/promises";
import { handleMessage } from "../agent/loop";
import { closeBrowsers } from "../booking/browser";
import { config, PEOPLE } from "../config";
import { logMessage } from "../db/repo";

const person = process.argv[2] ?? "Advait";
if (!PEOPLE.includes(person as never)) throw new Error(`person must be one of ${PEOPLE.join(", ")}`);

console.log(`Chatting as ${person} (DRY_RUN=${config.dryRun ? "on: nothing is really booked" : "OFF: bookings are real"}).`);
console.log('Try: "plan wednesday", "2", "what\'s booked?", or "~ ooh 2 looks good" (to the other person). Ctrl+C to quit.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("close", async () => {
  await closeBrowsers();
  process.exit(0);
});
for (;;) {
  const line = (await rl.question(`${person}> `)).trim();
  const addressed = !line.startsWith("~");
  const text = line.replace(/^~\s*/, "");
  if (!text) continue;
  logMessage(person, text);
  try {
    const reply = await handleMessage(person, text, { addressed });
    if (reply) {
      logMessage("planner", reply);
      console.log(`planner: ${reply}\n`);
    }
  } catch (err) {
    console.error("error:", err);
  }
}
