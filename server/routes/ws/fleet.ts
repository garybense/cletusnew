import { defineWebSocketHandler } from "nitro";
import { createFleetStreamSession } from "../../../src/lib/cletus/fleet-stream.server";

type StreamHandle = ReturnType<typeof createFleetStreamSession>;
const peerStreams = new Map<string, StreamHandle>();

export default defineWebSocketHandler({
  open(peer) {
    const stream = createFleetStreamSession({
      sendJson: (payload) => {
        try {
          peer.send(JSON.stringify(payload));
        } catch {
          // Ignore send failures on closing peer
        }
      },
      close: () => {
        try {
          peer.close(1000, "Session closed");
        } catch {
          // Ignore close errors
        }
      },
    });
    peerStreams.set(peer.id, stream);
  },
  async message(peer, message) {
    const stream = peerStreams.get(peer.id);
    if (!stream) return;
    await stream.onClientMessage(message.text());
  },
  async close(peer) {
    const stream = peerStreams.get(peer.id);
    peerStreams.delete(peer.id);
    if (stream) {
      await stream.close();
    }
  },
  async error(peer) {
    const stream = peerStreams.get(peer.id);
    peerStreams.delete(peer.id);
    if (stream) {
      await stream.close();
    }
  },
});
