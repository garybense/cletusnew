import { defineWebSocketHandler } from "nitro";
import { createLiveBridgeSession } from "../../../src/lib/cletus/live-bridge.server";

type BridgeHandle = ReturnType<typeof createLiveBridgeSession>;
const peerBridges = new Map<string, BridgeHandle>();

export default defineWebSocketHandler({
  open(peer) {
    const bridge = createLiveBridgeSession({
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
    peerBridges.set(peer.id, bridge);
  },
  async message(peer, message) {
    const bridge = peerBridges.get(peer.id);
    if (!bridge) return;
    await bridge.onClientMessage(message.text());
  },
  async close(peer) {
    const bridge = peerBridges.get(peer.id);
    peerBridges.delete(peer.id);
    if (bridge) {
      await bridge.close();
    }
  },
  async error(peer) {
    const bridge = peerBridges.get(peer.id);
    peerBridges.delete(peer.id);
    if (bridge) {
      await bridge.close();
    }
  },
});
