/** npx tsx src/scripts/snapshot-for-test.ts <live planner.db> <output file> (see deploy/sync-test-data.sh) */
import { snapshotForTest } from "../db/snapshot";

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error("usage: snapshot-for-test <live planner.db> <output file>");
  process.exit(1);
}
await snapshotForTest(from, to);
console.log(`Copied ${from} → ${to} (no chat history, logs, reminders or pending call).`);
