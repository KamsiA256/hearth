// SIMULATED ACCESS GATE — NOT AUTHENTICATION.
//
// The code `demo` opens the walkthrough. The page sends it by itself; it is not a
// secret, and it proves nothing about who is using the app.
//
// What it does do is carry the organization scoping the API depends on: a request is
// limited to the organizations named here, and a record outside them is reported
// exactly as a record that does not exist. Real products put real authentication in
// this place; this one does not pretend to.
import { demoOrganizationIds } from "./db.mjs";

export const DEMO_ACCESS_CODE = "demo";

// A copy can set its own code, and the page then asks for it. Still a gate, still
// not authentication.
// (`globalThis.process` because this file also runs inside the offline page.)
const accessCode = () => globalThis.process?.env?.HEARTH_ACCESS_CODE || DEMO_ACCESS_CODE;

export function resolveOperator(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || "";
  return header === `Bearer ${accessCode()}` ? { name: "Demo operator", organizationIds: demoOrganizationIds } : null;
}
