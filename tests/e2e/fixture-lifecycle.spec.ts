import { once } from "node:events";
import { connect } from "node:net";
import { expect, test } from "@playwright/test";
import { creativeFixture } from "./creative-fixture.js";

test("creative fixture closes with an unused browser connection", async () => {
  const fixture = await creativeFixture();
  const address = new URL(fixture.address);
  const socket = connect(Number(address.port), address.hostname);
  await once(socket, "connect");
  let closed = false;
  const closing = fixture.close().then(() => {
    closed = true;
  });
  try {
    await expect.poll(() => closed, { timeout: 1000 }).toBe(true);
  } finally {
    socket.destroy();
    await closing;
  }
});
