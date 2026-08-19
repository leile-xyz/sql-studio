const MISSING_CREDENTIAL_MESSAGE = '会话已过期，未找到已保存的登录凭据，请重新登录';

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new Error(`${name} 必须是函数`);
  return value;
}

function savedCredential(credential) {
  if (!credential?.remember || !credential.user || !credential.password) {
    throw new Error(MISSING_CREDENTIAL_MESSAGE);
  }
  return Object.freeze({ username: credential.user, password: credential.password });
}

export function createSessionRecovery(options) {
  const getCredential = requireFunction(options?.getCredential, 'getCredential');
  const login = requireFunction(options?.login, 'login');
  const onRecovered = options?.onRecovered == null
    ? async () => {}
    : requireFunction(options.onRecovered, 'onRecovered');
  const onFailure = options?.onFailure == null
    ? async () => {}
    : requireFunction(options.onFailure, 'onFailure');

  return async session => {
    try {
      const credential = savedCredential(await getCredential(session.envId));
      if (credential.username !== session.username) {
        throw new Error('会话已过期，保存的用户名与当前会话不一致，请重新登录');
      }
      await login(session.envId, session.origin, credential.username, credential.password);
      await onRecovered(Object.freeze({ ...session, username: credential.username }));
    } catch (error) {
      await onFailure(Object.freeze({ ...session }), error);
      throw error;
    }
  };
}
