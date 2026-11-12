// Reviewer build only: no file system in a browser page. Nothing is read or
// persisted; the payment store lives in page memory and is gone on reload.
export const existsSync = () => false;
export const readFileSync = () => { throw new Error("no file system in the reviewer build"); };
export const writeFileSync = () => {};
export const mkdirSync = () => {};
export const renameSync = () => {};
