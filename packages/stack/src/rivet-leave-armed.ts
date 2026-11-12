/**
 * Test helper for rivet.test.ts. Starts a rivet stack, begins a turn that stays open (a held terminal
 * command), waits until the session has armed a wake timer, and ends the process with that turn still open, the way
 * an aborted run does. The engine store then holds an actor with a timer for the next process to find.
 */
import { createRivetStack } from "./rivet.ts";
import { terminalCall } from "./world.ts";

const s = await createRivetStack({ script: [{ toolCalls: [terminalCall({ stdout: "x\n", hold: "c1" })] }, { reply: "never" }] });
await s.send("start a turn and leave it open");
const end = Date.now() + 20_000;
while ((await s.rows("s1", "SELECT 1 FROM wake_timers")).length === 0) {
  if (Date.now() > end) throw new Error("no wake timer was armed");
  await new Promise((r) => setTimeout(r, 50));
}
// Stop the engine cleanly (so the next process can bind its ports); the turn and its timer stay in the store.
await s.close();
console.log("ARMED");
process.exit(0);
