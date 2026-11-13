// Node's file, process and server modules have no place in the console: anything that reaches
// for them there is a mistake, and fails loudly.
const refuse = (name) => () => {
    throw new Error(`${name} is not available in the keeper console`);
};
export const existsSync = () => false;
export const readFileSync = refuse("readFileSync");
export const writeFileSync = refuse("writeFileSync");
export const mkdirSync = refuse("mkdirSync");
export const renameSync = refuse("renameSync");
export const rmSync = refuse("rmSync");
export const openSync = refuse("openSync");
export const closeSync = refuse("closeSync");
export const fsyncSync = refuse("fsyncSync");
export const writeSync = refuse("writeSync");
export const readdirSync = refuse("readdirSync");
export const statSync = refuse("statSync");
export const chmodSync = refuse("chmodSync");
export const resolve = (...parts) => parts.filter(Boolean).join("/");
export const dirname = (p) => String(p ?? "").split("/").slice(0, -1).join("/");
export const join = (...parts) => parts.filter(Boolean).join("/");
export const relative = (a, b) => b;
export const sep = "/";
export const isDeepStrictEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const spawn = refuse("spawn");
export class DatabaseSync {
    constructor() {
        throw new Error("DatabaseSync is not available in the keeper console");
    }
}
export const createServer = refuse("createServer");
export default {};
export const realpathSync = (p) => p;
export const unlinkSync = refuse("unlinkSync");
export const lstatSync = refuse("lstatSync");
