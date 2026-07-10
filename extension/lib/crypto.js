/**
 * 加密工具 — AES-256-GCM，密钥由扩展 ID 派生（零配置「记住密码」）。
 * 说明：以扩展 ID 作为密钥材料属于「混淆存储」而非强安全，能防止本地明文直读；
 * 它不能抵御可读取扩展源码与本地存储的攻击者。
 */

const SALT = 'sql-studio-storage-v1';

let cachedKey = null;

function extensionId() {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        return chrome.runtime.id;
    }
    return 'sql-studio-dev';
}

async function deriveKey() {
    if (cachedKey) return cachedKey;
    const encoder = new TextEncoder();
    const material = encoder.encode(extensionId() + SALT);
    const hash = await crypto.subtle.digest('SHA-256', material);
    cachedKey = await crypto.subtle.importKey(
        'raw', hash, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    return cachedKey;
}

/** 加密字符串 → base64(iv + 密文)；空串原样返回 */
export async function encryptText(plaintext) {
    if (!plaintext) return '';
    const key = await deriveKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(plaintext);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    const combined = new Uint8Array(iv.length + cipher.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipher), iv.length);
    return btoa(String.fromCharCode(...combined));
}

/** 解密 base64(iv + 密文) → 字符串；格式或认证失败时显式报错。 */
export async function decryptText(ciphertext) {
    if (!ciphertext) return '';
    try {
        const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
        if (combined.length < 13) throw new Error('密文长度不足');
        const key = await deriveKey();
        const iv = combined.slice(0, 12);
        const data = combined.slice(12);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
        return new TextDecoder().decode(plain);
    } catch (cause) {
        throw new Error('保存的密码无法解密，请清除后重新保存', { cause });
    }
}
