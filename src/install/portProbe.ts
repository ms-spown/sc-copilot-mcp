import net from "node:net";

export type PortState = "open" | "closed";

/** Asks whether something accepts connections on a loopback port. It sends nothing and closes at once. */
export type PortProbe = (port: number) => Promise<PortState>;

export const probeLoopbackPort: PortProbe = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (state: PortState) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(800, () => finish("closed"));
    socket.once("connect", () => finish("open"));
    socket.once("error", () => finish("closed"));
  });
