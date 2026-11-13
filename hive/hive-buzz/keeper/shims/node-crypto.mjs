// The few node:crypto calls the hive's shared code makes, for the browser.
import { sha256 } from "@noble/hashes/sha2";

export function createHash(name) {
    if (name !== "sha256") throw new Error(`no ${name} in the console`);
    const parts = [];
    return {
        update(data) {
            parts.push(typeof data === "string" ? new TextEncoder().encode(data) : Uint8Array.from(data));
            return this;
        },
        digest(encoding) {
            const h = sha256.create();
            for (const p of parts) h.update(p);
            const out = h.digest();
            if (encoding === "hex") return Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("");
            return out;
        },
    };
}
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
export const timingSafeEqual = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
export default { createHash, randomBytes, timingSafeEqual };
export const createHmac = () => {
    throw new Error("createHmac is not available in the keeper console");
};
