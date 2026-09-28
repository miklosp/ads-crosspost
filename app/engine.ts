// utilityProcess entry. Will host the job engine and MCP server from src/; for now just answers pings.
const port = process.parentPort;

console.error("engine started");
port.on("message", (e) => { if (e.data?.type === "ping") port.postMessage({ type: "pong" }); });
setInterval(() => {}, 2 ** 31 - 1); // keep alive until the MCP server holds the event loop
