// File: docs/07-examples/production/auth-pattern.tsx

/**
 * Authentication Pattern Example
 * 
 * Status: ✅ Production pattern
 * Source: Extracted from real authentication flow patterns
 * 
 * This example shows the standard authentication pattern using
 * HTTP-only cookies for JWT tokens.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Login Form Component
 * 
 * Pattern: Simple form with email/password, submits to /api/auth/login
 * Token is automatically stored in HTTP-only cookie by backend
 */
export function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    
    setError(null);
    setLoading(true);
    
    try {
      // POST to login endpoint - token set in HTTP-only cookie automatically
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // Send cookies with request
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || 'Login failed');
      }

      // Success - redirect to dashboard
      navigate('/dashboard');
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="login-form">
      <h2>Login</h2>
      
      {error && (
        <div className="error-message">{error}</div>
      )}
      
      <div className="form-group">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={loading}
        />
      </div>
      
      <div className="form-group">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          disabled={loading}
        />
      </div>
      
      <button type="submit" disabled={loading}>
        {loading ? 'Logging in...' : 'Login'}
      </button>
    </form>
  );
}

/**
 * Protected Route Component
 * 
 * Pattern: Wrap routes that require authentication
 * Redirects to login if not authenticated
 */
export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    async function checkAuth() {
      try {
        const response = await fetch('/api/auth/me', {
          credentials: 'include', // Send cookies automatically
        });

        if (!response.ok) {
          // Not authenticated - redirect to login
          setIsAuthenticated(false);
          navigate('/login');
          return;
        }

        setIsAuthenticated(true);
      } catch (error) {
        console.error('Auth check failed:', error);
        setIsAuthenticated(false);
        navigate('/login');
      }
    }

    checkAuth();
  }, [navigate]);

  if (isAuthenticated === null) {
    return <div>Loading...</div>; // Auth checking in progress
  }

  if (!isAuthenticated) {
    return null; // Already redirected to login
  }

  return <>{children}</>;
}

/**
 * Logout Button Component
 * 
 * Pattern: Call /api/auth/logout to invalidate session
 */
export function LogoutButton() {
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleLogout() {
    setLoading(true);
    
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
      
      // Redirect to login after logout
      navigate('/login');
    } catch (error) {
      console.error('Logout failed:', error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button onClick={handleLogout} disabled={loading}>
      {loading ? 'Logging out...' : 'Logout'}
    </button>
  );
}

/**
 * Key Patterns:
 * 
 * 1. HTTP-only cookies for JWT storage (not localStorage)
 * 2. credentials: 'include' on all API requests to send cookies
 * 3. Protected routes check auth status before rendering
 * 4. Loading states during async operations
 * 5. Error handling with user-friendly messages
 */

/**
 * Usage Example:
 * 
 * import { ProtectedRoute } from './auth-pattern';
 * 
 * // In router configuration:
 * <Route element={<ProtectedRoute />}>
 *   <Route path="/dashboard" element={<Dashboard />} />
 * </Route>
 */
