import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { get, post } from '../api/client.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await get('/auth/me');
      setUser(r.data.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = async (email, password) => {
    const r = await post('/auth/login', { email, password });
    setUser(r.data.user);
    return r.data.user;
  };
  const register = async (payload) => {
    const r = await post('/auth/register-beekeeper', payload);
    setUser(r.data.user);
    return r.data.user;
  };
  const logout = async () => {
    await post('/auth/logout').catch(() => {});
    setUser(null);
  };

  return <AuthCtx.Provider value={{ user, loading, login, register, logout, refresh }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
