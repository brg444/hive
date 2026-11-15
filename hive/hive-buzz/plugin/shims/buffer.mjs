// Enough of Node's Buffer for the hive's shared byte helpers (hex, base64, utf-8), in the browser.
const te = new TextEncoder();
const td = new TextDecoder();
class PluginBuffer extends Uint8Array {
    static from(value, encoding) {
        if (typeof value === "string") {
            if (encoding === "hex") {
                if (value.length % 2) throw new Error("odd hex");
                const out = new PluginBuffer(value.length / 2);
                for (let i = 0; i < out.length; i++) {
                    const byte = Number.parseInt(value.slice(2 * i, 2 * i + 2), 16);
                    if (Number.isNaN(byte)) break;
                    out[i] = byte;
                }
                return out;
            }
            if (encoding === "base64") return PluginBuffer.wrap(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
            return PluginBuffer.wrap(te.encode(value));
        }
        return PluginBuffer.wrap(Uint8Array.from(value));
    }
    static wrap(bytes) {
        const out = new PluginBuffer(bytes.length);
        out.set(bytes);
        return out;
    }
    static concat(list) {
        const out = new PluginBuffer(list.reduce((n, b) => n + b.length, 0));
        let at = 0;
        for (const b of list) {
            out.set(b, at);
            at += b.length;
        }
        return out;
    }
    static alloc(n) {
        return new PluginBuffer(n);
    }
    static byteLength(value) {
        return typeof value === "string" ? te.encode(value).length : value.length;
    }
    static isBuffer(value) {
        return value instanceof PluginBuffer;
    }
    toString(encoding) {
        if (encoding === "hex") return Array.from(this, (b) => b.toString(16).padStart(2, "0")).join("");
        if (encoding === "base64") return btoa(String.fromCharCode(...this));
        return td.decode(this);
    }
}
export { PluginBuffer as Buffer };
