// Reviewer build only: the few node:path helpers the payment modules touch.
const join = (...parts) => parts.filter(Boolean).join("/").replace(/\/+/g, "/");
export default { join, dirname: (p) => String(p).split("/").slice(0, -1).join("/") || "." };
export { join };
