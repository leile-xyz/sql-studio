const params = new URLSearchParams(globalThis.window?.location?.search || '');
const token = params.get('token') || '';

export function invoke(command, args = {}) {
    const body = { command, args };
    return fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-SQL-Studio-Token': token },
        body: JSON.stringify(body),
    }).then(async response => {
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || `请求失败（HTTP ${response.status}）`);
        return payload.value;
    });
}

export function stopLocalService() {
    return invoke('exit').catch(() => undefined);
}
